import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import config from "../config.js";
import { AppError } from "../lib/AppError.js";
import { assertExcerptsVerified, assertOwnDocument } from "../lib/defensiveAssertions.js";
import prisma from "../lib/prisma.js";
import logger from "../observability/logger.js";

/**
 * STAGING ONLY. BUILD-PLAN step 68, item 3: two of Appendix C's alerts fire
 * on conditions the pipeline structurally prevents —
 * `unverified_excerpt_displayed` and `cross_user_access` — so PRD §9's
 * "every alert has been deliberately fired at least once" is impossible for
 * them without a way to plant the condition. These routes plant it.
 *
 * THREE THINGS KEEP THIS OUT OF PRODUCTION, not one:
 *   1. config.js refuses to boot in production when ALERT_DRILL_TOKEN is
 *      set at all.
 *   2. app.js mounts this router only when the token is set, so in an
 *      ordinary deployment these paths do not exist and answer 404 like any
 *      other unknown path.
 *   3. Every route requires the token, compared in constant time.
 * Layer 1 is the one that matters: even a mistake in 2 or 3 cannot expose
 * these in production, because a production process holding the token does
 * not start.
 *
 * WHAT EACH DRILL ACTUALLY PROVES, stated so the drill record does not
 * overclaim:
 *
 *   /unverified-excerpt  A real end-to-end drill. It writes a Finding row
 *       with an excerpt that is not in its document, bypassing
 *       services/analysis.js exactly as a bad migration or a future
 *       feature would, then reads the report through the ORDINARY route.
 *       The assertion, the metric, the 500 and the log line are all the
 *       production ones.
 *
 *   /cross-user-access   A drill of the ASSERTION, not of the whole path.
 *       lib/ownership.js filters by userId inside the query, so no request
 *       can make it return another user's row; there is nothing to plant.
 *       This route instead loads a document WITHOUT the userId filter —
 *       the shape of the bug the alert exists for — and passes it through
 *       the same assertion the ordinary path calls. What is exercised is
 *       the detection, the metric, and the refusal to serve. What is not
 *       exercised is a real query losing its filter, which no drill can
 *       simulate without shipping the bug.
 *
 * Every drill CLEANS UP after itself and none of them return the planted
 * data, whatever it was.
 */

const router = Router();

/** @param {string} value */
const digest = (value) => createHash("sha256").update(value).digest();

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} _res
 * @param {import("express").NextFunction} next
 */
function requireDrillToken(req, _res, next) {
  const token = config.ALERT_DRILL_TOKEN;
  // Unreachable through app.js, which mounts this router only when the
  // token is set. Kept so that this file is safe on its own terms.
  if (!token) {
    next(new AppError("NOT_FOUND"));
    return;
  }
  const presented = req.get("X-Alert-Drill") ?? "";
  if (!timingSafeEqual(digest(presented), digest(token))) {
    next(new AppError("UNAUTHENTICATED"));
    return;
  }
  next();
}

router.use(requireDrillToken);

/**
 * POST /api/v1/drills/unverified-excerpt
 * Body: { documentId }
 *
 * Plants an unverifiable excerpt on the document's latest analysis, then
 * asserts over the stored rows the way the report route does. Always
 * removes the planted row, including when the assertion throws — which is
 * the expected outcome, so a 500 here means the drill WORKED.
 */
router.post("/unverified-excerpt", async (req, res, next) => {
  /** @type {string | undefined} */
  let plantedId;
  try {
    const documentId = String(req.body?.documentId ?? "");
    const document = await prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new AppError("NOT_FOUND");
    const analysis = await prisma.analysis.findFirst({
      where: { documentId, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
    });
    if (!analysis) throw new AppError("VALIDATION_ERROR", { message: "The document has no completed analysis to plant on." });

    logger.warn(
      { drill: "unverified_excerpt_displayed", analysis: { id: analysis.id, documentId } },
      "ALERT DRILL: planting an excerpt that is not in the document",
    );
    const planted = await prisma.finding.create({
      data: {
        analysisId: analysis.id,
        category: "OTHER",
        severity: "HIGH",
        // Deliberately absent from any contract. Not fabricated-looking
        // legal text: a drill row that could be mistaken for a real finding
        // if the cleanup below ever failed would be its own hazard.
        clauseExcerpt: "ALERT DRILL ROW — this sentence is not in the document (step 68).",
        explanation: "Planted by the alert drill; never served.",
        suggestedChange: "Planted by the alert drill; never served.",
      },
    });
    plantedId = planted.id;

    const findings = await prisma.finding.findMany({ where: { analysisId: analysis.id } });
    assertExcerptsVerified(findings, document.rawText, {
      path: "report",
      analysisId: analysis.id,
      documentId,
    });

    // Only reachable if the assertion did NOT fire, which is a failed drill.
    res.status(500).json({
      drill: "unverified_excerpt_displayed",
      fired: false,
      message: "The assertion did not fire. The Sev-1 detection is broken.",
    });
  } catch (err) {
    next(err);
  } finally {
    if (plantedId) await prisma.finding.delete({ where: { id: plantedId } }).catch(() => {});
  }
});

/**
 * POST /api/v1/drills/cross-user-access
 * Body: { documentId, subjectId }
 *
 * Loads the document with no owner filter and asserts it belongs to
 * `subjectId`. See the file header for what this does and does not prove.
 * A 500 means the drill worked.
 */
router.post("/cross-user-access", async (req, res, next) => {
  try {
    const documentId = String(req.body?.documentId ?? "");
    const subjectId = String(req.body?.subjectId ?? "");
    // No `userId` in the where clause: the bug this alert exists for.
    const document = await prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw new AppError("NOT_FOUND");

    logger.warn(
      { drill: "cross_user_access", document: { id: documentId } },
      "ALERT DRILL: asserting ownership for a subject that does not own the document",
    );
    assertOwnDocument(document, subjectId);

    res.status(500).json({
      drill: "cross_user_access",
      fired: false,
      message: "The assertion did not fire. The Sev-1 detection is broken.",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
