import { Gauge, register } from "prom-client";
import prisma from "../lib/prisma.js";
import logger from "../observability/logger.js";
import { startRecurring, stopRecurring } from "./scheduler.js";

/**
 * FR-3.8 / SRS §12.3 — the stale-analysis reaper.
 *
 * WHAT IT FIXES. A PENDING analysis is created by one HTTP request
 * (services/analysis.js) and normally finishes, one way or another, in
 * that same request. If the process crashes or is killed mid-analysis —
 * an OOM, a bad deploy, the platform force-killing an instance — the
 * PENDING row is orphaned: nothing will ever move it to COMPLETED or
 * FAILED, and FR-3.8's partial unique index means the document can never
 * be analyzed again while that row exists. This job is what turns an
 * orphaned row back into a normal, retryable failure.
 *
 * THE USER-VISIBLE CONSEQUENCE, stated because it shapes the error copy
 * (analyzeErrors.js): the threshold is 5 minutes and the job runs every
 * 60 seconds, so a request that crashed a PENDING row can leave
 * ANALYSIS_IN_PROGRESS showing for up to roughly 6 minutes afterward —
 * not instantly retryable, and the copy must not suggest otherwise.
 *
 * WHY AN ADVISORY LOCK AND NOT AN IN-PROCESS FLAG (§2's second critical
 * constraint): this API runs as two or more stateless instances, each
 * running its own copy of this job on its own timer. An in-process
 * "already running" flag only stops ONE instance from double-running
 * itself; it does nothing about two DIFFERENT instances reaping the same
 * rows in the same minute. `pg_try_advisory_xact_lock` is scoped to the
 * database, not the process, so it is the only thing that actually
 * serializes instances against each other — the same reasoning as
 * storageQuota.js's per-user lock, here applied globally since this job
 * has no per-row key to shard on.
 *
 * NON-BLOCKING ON PURPOSE (`pg_try_advisory_xact_lock`, not
 * `pg_advisory_xact_lock`). Instance B, arriving in the same minute as
 * instance A, has no reason to wait for A to finish and then redundantly
 * re-run the same sweep — A already did the work, and B will get another
 * chance in 60 seconds regardless. A blocking lock would just make B's
 * tick hang for no benefit.
 *
 * THE GAUGE IS MEASURED BEFORE THE LOCK ATTEMPT, AND BY EVERY INSTANCE,
 * WHETHER OR NOT IT WINS THE LOCK. This is deliberate, not an oversight:
 * Appendix C's alert exists to catch the reaper HAVING STOPPED WORKING
 * (a crash loop, a persistent DB error inside the UPDATE, the job never
 * getting wired up at all) — and in that scenario there is no
 * lock-winner to report the growing backlog. A gauge only the winner
 * updated would go silent in exactly the failure this metric exists to
 * catch. A plain COUNT costs one query and needs no lock, so every
 * instance can report the same ground truth on every tick.
 */

/** FR-3.8's own number. */
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/** §12.3's cadence. */
export const REAP_INTERVAL_MS = 60 * 1000;

/**
 * hashtext() returns int4, which Postgres implicitly widens to the
 * bigint pg_try_advisory_xact_lock(key bigint) expects — the same
 * pattern storageQuota.js uses for its per-user lock, here on a fixed
 * string because this job has no per-row key to shard on.
 */
const REAPER_LOCK_KEY = "reaper:stale-analysis-sweep";

/**
 * Looked up before creation, like email.js's emailSendTotal: a module
 * re-imported under `vi.resetModules()` would otherwise try to register
 * the same metric name twice on prom-client's default registry and
 * throw.
 */
export const stalePendingAnalysesGauge =
  /** @type {Gauge | undefined} */ (register.getSingleMetric("stale_pending_analyses")) ??
  new Gauge({
    name: "stale_pending_analyses",
    help:
      "PENDING analyses older than FR-3.8's 5-minute staleness threshold, counted at the " +
      "start of the most recent reaper tick, before that tick's own sweep runs (Appendix C alert: >5).",
  });

/**
 * One reaper tick: count what is stale (for the gauge), then — if this
 * call wins the advisory lock — mark it FAILED/STALE_ANALYSIS.
 *
 * Exported and callable directly (not only via the scheduler below) so
 * tests can run exactly one tick, at an exact `now`, and inspect exactly
 * what it did.
 *
 * @param {Date} [now]
 * @returns {Promise<{ lockAcquired: boolean, staleCountAtStart: number, reaped: number }>}
 */
export async function reapStaleAnalyses(now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_THRESHOLD_MS);

  logger.info({ job: "reaper" }, "reaper tick started");

  const staleCountAtStart = await prisma.analysis.count({
    where: { status: "PENDING", createdAt: { lt: cutoff } },
  });
  stalePendingAnalysesGauge.set(staleCountAtStart);

  // The lock attempt and the sweep it guards are one transaction:
  // pg_try_advisory_xact_lock releases automatically at commit or
  // rollback, so no failure path — including this function throwing —
  // can leak a held lock into the next tick.
  const outcome = await prisma.$transaction(async (tx) => {
    const [{ locked }] = /** @type {[{ locked: boolean }]} */ (
      await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${REAPER_LOCK_KEY})) AS locked`
    );

    if (!locked) {
      return { lockAcquired: false, reaped: 0 };
    }

    // The same WHERE this function counted with above, evaluated fresh
    // inside the lock: only a PENDING row still older than the cutoff is
    // touched, so a row that completed normally in the gap between the
    // count and this UPDATE is correctly left alone.
    const { count: reaped } = await tx.analysis.updateMany({
      where: { status: "PENDING", createdAt: { lt: cutoff } },
      data: { status: "FAILED", errorCode: "STALE_ANALYSIS", completedAt: now },
    });

    return { lockAcquired: true, reaped };
  });

  logger.info({ job: "reaper", staleCountAtStart, ...outcome }, "reaper tick finished");

  return { staleCountAtStart, ...outcome };
}

/**
 * Wires `reapStaleAnalyses` to §12.3's every-minute cadence, through the
 * scheduler every §12.3 job shares (jobs/scheduler.js): once immediately
 * on boot, then every `intervalMs`, a failed tick logged and dropped.
 *
 * `tick` is injectable so a test can prove the scheduling without a
 * database — `reapStaleAnalyses` itself is tested against a real Postgres
 * in tests/integration/reaper.test.js.
 *
 * @param {{ tick?: (now?: Date) => Promise<unknown>, intervalMs?: number }} [options]
 * @returns {NodeJS.Timeout} pass to `stopReaper` to cancel
 */
export function startReaper({ tick = reapStaleAnalyses, intervalMs = REAP_INTERVAL_MS } = {}) {
  return startRecurring({ job: "reaper", tick: () => tick(), intervalMs });
}

/** @param {NodeJS.Timeout} handle */
export function stopReaper(handle) {
  stopRecurring(handle);
}
