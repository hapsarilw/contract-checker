import { Router } from "express";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/AppError.js";
import { loadOwnedDocument } from "../lib/ownership.js";
import { serializeDocument, serializeAnalysis, serializeDocumentListRow } from "../lib/serializers.js";
import { requireAuth } from "../middleware/auth.js";
import { analyzeLimiter } from "../middleware/rateLimits.js";
import { limitConcurrentUploads } from "../middleware/uploadConcurrency.js";
import { createDocumentWithinQuota } from "../services/storageQuota.js";
import {
  rejectOversizeByContentLength,
  singleFileUpload,
  sanitizeFilename,
} from "../middleware/upload.js";
import { analyzeDocument } from "../services/analysis.js";
import { intakeUpload, intakePastedText } from "../services/intake.js";
import { pasteDocumentSchema } from "../schemas/document.js";
import { decodeCursor, encodeCursor, resolvePageLimit } from "../lib/pagination.js";
import { findIdempotentResponse, readIdempotencyKey, storeIdempotentResponse } from "../lib/idempotency.js";

const router = Router();

/**
 * FR-3.15 middleware: on a cache hit, answers with the ORIGINAL response
 * and never calls next() — the handler below, and everything mounted
 * ahead of it (content-length check, upload concurrency slot, multer),
 * never runs for a replay.
 *
 * On a miss (no header, an unusable header, or nothing cached yet) it
 * stashes the key on `req.idempotencyKey` so the handler can store the
 * response once it has one, and calls next() unconditionally — a client
 * that never sent the header sees no change in behaviour at all, which
 * is FR-3.15's own "a request with no key behaves as before".
 */
async function replayIdempotentRequest(req, res, next) {
  try {
    const key = readIdempotencyKey(req);
    if (!key) {
      next();
      return;
    }

    req.idempotencyKey = key;

    const cached = await findIdempotentResponse(req.auth.userId, key);
    if (cached) {
      res.status(cached.status).json(cached.body);
      return;
    }

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/documents — FR-2.1: multipart upload (field "file") or
 * pasted JSON text, on the SAME path, distinguished by Content-Type.
 * That's also exactly what FR-1.12(c)'s CSRF allowlist permits, and no
 * coincidence — the two decisions were made together.
 *
 * Middleware order matters and follows the intake precedence documented
 * in upload.js: auth first (the §2 diagram puts it before anything
 * body-related), then the Content-Length pre-check (413, before any
 * byte is buffered), then Multer (which safely no-ops — verified,
 * req.file stays undefined and next() is called cleanly — when the
 * request isn't multipart, so mounting it unconditionally here is
 * correct rather than a shortcut).
 *
 * FR-1.7 does not gate this route. An UNVERIFIED account may create
 * documents; only POST /documents/:id/analyze checks verification
 * (step 52) — this file has no state check and must not grow one.
 *
 * FR-3.15's Idempotency-Key check runs FIRST, immediately after auth and
 * before any of it — the content-length check, the upload-concurrency
 * slot, multer — because a replayed request should cost nothing beyond
 * one Redis read. A cache hit answers directly from
 * replayIdempotentRequest and never reaches this handler at all.
 */
router.post(
  "/",
  requireAuth,
  replayIdempotentRequest,
  rejectOversizeByContentLength,
  // FR-2.12, between the cheap header check and the expensive buffering:
  // a slot claimed after multer has read the bytes has already failed to
  // bound the memory it exists to bound.
  limitConcurrentUploads,
  singleFileUpload,
  async (req, res, next) => {
    try {
      let intakeResult;
      let filename;

      if (req.file) {
        // detectSourceType (step 16), then the matching parser (step
        // 17), then FR-2.5/FR-2.6's word-count bounds — all inside
        // intakeUpload, in that order.
        intakeResult = await intakeUpload(req.file.buffer);
        filename = sanitizeFilename(req.file.originalname);
      } else {
        const parsed = pasteDocumentSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError("VALIDATION_ERROR", {
            details: {
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            },
          });
        }
        intakeResult = intakePastedText(parsed.data.text);
        filename = null;
      }

      // FR-2.13: the quota check and the insert are one transaction, so
      // two concurrent uploads cannot both pass at document 99.
      const document = await createDocumentWithinQuota(req.auth.userId, {
        filename,
        ...intakeResult,
      });

      const body = { document: serializeDocument(document) };

      // FR-3.15: only when a key was actually offered. AWAITED, so the
      // key exists in Redis before the client can possibly see this 201
      // and retry — not doing so would reopen the exact "response before
      // the row exists" race step 56 already found once with the audit
      // trail.
      if (req.idempotencyKey) {
        await storeIdempotentResponse(req.auth.userId, req.idempotencyKey, 201, body);
      }

      res.status(201).json(body);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/v1/documents — FR-4.1, §4.4. Reverse chronological, cursor
 * paginated. Each row is filename (or "Pasted text"), word count, the
 * overall risk of the latest COMPLETED analysis specifically (not the
 * latest analysis of any status — see serializeDocumentListRow), a
 * finding count, and the created date.
 *
 * A malformed or tampered cursor is 400 VALIDATION_ERROR, decided
 * entirely inside decodeCursor (pagination.js) — this handler never
 * sees the raw decode failure, only a clean null.
 *
 * The keyset WHERE clause below is the entire reason deleting a
 * document between two page fetches causes neither a skipped nor a
 * duplicated row: "the next page" is defined as "documents before THIS
 * (createdAt, id) tuple", never as "skip N rows from the top". Deleting
 * an unrelated document changes nothing about what that comparison
 * means.
 */
router.get("/", requireAuth, async (req, res, next) => {
  try {
    let cursor;
    if (req.query.cursor !== undefined) {
      cursor = decodeCursor(req.query.cursor);
      if (!cursor) {
        throw new AppError("VALIDATION_ERROR", { details: { field: "cursor" } });
      }
    }

    const limit = resolvePageLimit(req.query.limit);

    // Fetch one extra row past `limit` — its presence, not a second
    // COUNT query, is what tells us hasMore.
    const rows = await prisma.document.findMany({
      where: {
        userId: req.auth.userId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: {
        analyses: {
          where: { status: "COMPLETED" },
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { _count: { select: { findings: true } } },
        },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    res.status(200).json({
      documents: page.map((document) => serializeDocumentListRow(document, document.analyses[0])),
      page: {
        nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
        hasMore,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/documents/:id — the document plus its LATEST analysis
 * (§4's endpoint table), regardless of that analysis's status.
 *
 * "Latest" is not filtered to COMPLETED: this is a direct reading of
 * "latest analysis", and a user whose most recent attempt is PENDING or
 * FAILED should see that state rather than the route silently acting as
 * if no analysis had ever run.
 */
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const document = await loadOwnedDocument(req.params.id, req.auth.userId);

    const analysis = await prisma.analysis.findFirst({
      where: { documentId: document.id },
      orderBy: { createdAt: "desc" },
      include: { findings: true },
    });

    res.status(200).json({
      document: serializeDocument(document),
      analysis: analysis ? serializeAnalysis(analysis) : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/documents/:id/analyze — §2.2's sequence, run synchronously
 * (FR-3.7) by services/analysis.js, returning the full report with 200 as in
 * §4.3's example. serializeAnalysis sorts findings high to medium to low
 * (§2.2 step 12) and never includes modelRisk (PRD D7).
 *
 * NFR-2.6: analyzeLimiter (10/hour, keyed by userId) mounts AFTER
 * requireAuth deliberately — its keyGenerator reads req.auth.userId,
 * which only exists once requireAuth has populated it.
 */
router.post("/:id/analyze", requireAuth, analyzeLimiter, async (req, res, next) => {
  try {
    const analysis = await analyzeDocument({
      documentId: req.params.id,
      userId: req.auth.userId,
    });
    res.status(200).json({ analysis: serializeAnalysis(analysis) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/documents/:id — FR-4.3: a permanent hard delete, no
 * soft-delete flag (PRD D2). Cascades to Analysis and Finding through
 * the `onDelete: Cascade` foreign keys declared in schema.prisma (step
 * 9) — a single DELETE statement, not application-level cleanup code
 * that could be forgotten or race.
 *
 * Ownership is checked first via loadOwnedDocument (404, never 403 —
 * FR-1.5), THEN deleted by id. Prisma's delete() needs a unique `where`
 * and there's no compound (id, userId) unique constraint, so this can't
 * be a single filtered query — but no race matters here the way it did
 * for the FR-3.8 pending-analysis guard: ownership of a document isn't
 * something that changes concurrently, so verify-then-act is sufficient.
 */
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const document = await loadOwnedDocument(req.params.id, req.auth.userId);

    await prisma.document.delete({ where: { id: document.id } });

    res.status(200).json({
      deleted: true,
      message:
        "This document, its analyses, and its findings have been permanently deleted. " +
        "Backups are retained for up to 30 days before they age out.",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
