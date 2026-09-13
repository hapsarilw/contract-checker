import { Router } from "express";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/AppError.js";
import { loadOwnedDocument } from "../lib/ownership.js";
import { serializeDocument, serializeAnalysis } from "../lib/serializers.js";
import { requireAuth } from "../middleware/auth.js";
import {
  rejectOversizeByContentLength,
  singleFileUpload,
  sanitizeFilename,
} from "../middleware/upload.js";
import { intakeUpload, intakePastedText } from "../services/intake.js";
import { pasteDocumentSchema } from "../schemas/document.js";

const router = Router();

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
 */
router.post(
  "/",
  requireAuth,
  rejectOversizeByContentLength,
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

      const document = await prisma.document.create({
        data: {
          userId: req.auth.userId,
          filename,
          ...intakeResult,
        },
      });

      res.status(201).json({ document: serializeDocument(document) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/v1/documents/:id — the document plus its LATEST analysis
 * (§4's endpoint table), regardless of that analysis's status.
 *
 * "Latest" is not filtered to COMPLETED: this is a direct reading of
 * "latest analysis", and a user whose most recent attempt is PENDING or
 * FAILED should see that state rather than the route silently acting as
 * if no analysis had ever run. No route in this codebase can create a
 * non-null Analysis row yet (POST .../analyze doesn't exist until step
 * 25), so `analysis` is always null today; this shape is what step 25
 * will populate without documents.js needing to change.
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
