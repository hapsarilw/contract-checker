import express, { Router } from "express";
import { AppError } from "../lib/AppError.js";
import { normalizeCspReports } from "../lib/cspReports.js";
import { cspReportLimiter } from "../middleware/rateLimits.js";
import logger from "../observability/logger.js";
import { cspViolationTotal } from "../observability/metrics.js";

/**
 * POST /api/csp-report — FR-7.9's "violations report to an endpoint during
 * rollout" (BUILD-PLAN step 75). The static host's policy names it twice
 * (client/scripts/staticHostHeaders.js): `report-uri` for browsers that
 * still use it, and `report-to` for the Reporting API.
 *
 * MOUNTED BEFORE csrfGuard, on purpose (app.js). A browser sends these
 * with Content-Type application/csp-report or application/reports+json,
 * which FR-1.12(c) refuses on every state-changing route. The guard's job
 * is to stop a browser being made to act with someone's session; this
 * route reads no session and changes nothing but a counter and a log line,
 * so there is nothing for that to protect. What it needs instead it has
 * here: a small body limit and its own rate limit.
 *
 * Always 204 for a body it could read, whatever was in it: a reporter
 * learns nothing from the answer, and a browser ignores it anyway.
 */
const router = Router();

const REPORT_TYPES = [
  "application/csp-report",
  "application/reports+json",
  "application/json",
];
// A real report is well under 2 KB; the Reporting API may batch a few.
const REPORT_BODY_LIMIT = "16kb";

router.post(
  "/",
  cspReportLimiter,
  express.json({ type: REPORT_TYPES, limit: REPORT_BODY_LIMIT }),
  (req, res) => {
    for (const violation of normalizeCspReports(req.body)) {
      cspViolationTotal.inc({ directive: violation.directive });
      logger.warn(
        { csp: violation },
        "FR-7.9: Content-Security-Policy violation reported",
      );
    }
    res.status(204).end();
  },
);

// The body parser's own errors, in the API's vocabulary, and stated for
// this route rather than app.js's translator, whose 413 message is about
// pasted contract text.
router.use(
  /** @type {import("express").ErrorRequestHandler} */
  (err, req, res, next) => {
    const type = typeof err?.type === "string" ? err.type : "";
    if (type === "entity.too.large") {
      next(
        new AppError("FILE_TOO_LARGE", {
          message: `A policy report is limited to ${REPORT_BODY_LIMIT}.`,
        }),
      );
      return;
    }
    if (
      type.startsWith("entity.") ||
      type.startsWith("charset.") ||
      type.startsWith("encoding.")
    ) {
      next(new AppError("VALIDATION_ERROR", { details: { bodyParserType: type } }));
      return;
    }
    next(err);
  },
);

export default router;
