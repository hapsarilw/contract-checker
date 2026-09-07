import { Router } from "express";
import config from "../config.js";
import { checkPostgres, checkRedis } from "../lib/readinessChecks.js";

/**
 * FR-4.7 / FR-4.8 — mounted OUTSIDE /api/v1 (§4: these are operational
 * surface, not product surface).
 */
const router = Router();

/**
 * Liveness only: process responsiveness, no dependency checks, always
 * fast. FR-4.7 is explicit about why — a health probe that touches the
 * database restarts every healthy instance during a database blip.
 */
router.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

/**
 * Readiness: verifies every dependency and returns a per-dependency
 * breakdown either way, so an operator can see WHICH dependency failed
 * rather than just that something did.
 */
router.get("/ready", async (req, res) => {
  const [postgres, redis] = await Promise.all([checkPostgres(), checkRedis()]);
  const checks = { postgres, redis };
  const allOk = Object.values(checks).every((check) => check.ok);

  res.status(allOk ? 200 : 503).json({ status: allOk ? "ready" : "not_ready", checks });
});

/**
 * "Which code is actually running" during an incident — sourced from
 * GIT_SHA and BUILD_TIMESTAMP (Appendix B), both set by CI at build
 * time. Neither is required in Phase 1 (they read as required starting
 * at the P1.5 gate), so both may be null until step 40 wires them.
 */
router.get("/version", (req, res) => {
  res.status(200).json({
    gitSha: config.GIT_SHA ?? null,
    buildTimestamp: config.BUILD_TIMESTAMP ?? null,
  });
});

export default router;
