import { Gauge, register } from "prom-client";
import prisma from "../lib/prisma.js";
import logger from "../observability/logger.js";

/**
 * SRS §12.3: every scheduled job "exports a last-success metric that
 * Appendix C alerts on." This module is where that time is recorded, and
 * the gauge every instance exports it through.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE (step 61's own warning). A job runs on
 * ONE instance — whichever wins its advisory lock — but Prometheus scrapes
 * EVERY instance. If the winner set a gauge in its own memory, the other
 * instances would export nothing, or their own stale boot-time value, and
 * `retention_job_stale` (last success > 36 h) would fire from every
 * instance that didn't happen to run the job last night. That is a false
 * page, every day, about a published privacy-policy claim.
 *
 * So nothing here is held in memory. The last-success time is a row in
 * the JobRun table, written by whichever instance finished the run, and
 * the gauge has no value of its own: its `collect()` reads that row every
 * time it is scraped. Every instance therefore exports the same number,
 * and the number is only ever as true as the database.
 */

/**
 * The jobs this gauge reports on. A job listed here and never yet run is
 * exported as 0, not omitted — see the note in `collect` below.
 */
export const KNOWN_JOBS = Object.freeze(["retention"]);

export const LAST_SUCCESS_METRIC = "retention_job_last_success_timestamp";

/**
 * @param {string} job
 * @param {Date} at
 * @param {{ jobRun: typeof prisma.jobRun }} [db] a transaction client, or
 *   the default one
 */
export async function recordJobSuccess(job, at, db = prisma) {
  await db.jobRun.upsert({
    where: { job },
    create: { job, lastSuccessAt: at },
    update: { lastSuccessAt: at },
  });
}

/**
 * @param {string} job
 * @returns {Promise<Date | null>}
 */
export async function readJobSuccess(job) {
  const row = await prisma.jobRun.findUnique({ where: { job } });
  return row?.lastSuccessAt ?? null;
}

/**
 * Builds the gauge. Exported as a factory, not only as the instance below,
 * so a test can register a SECOND copy on a separate registry — a stand-in
 * for a second instance that has never run the job itself — and prove it
 * reads the value the first one wrote.
 *
 * Unix SECONDS, the Prometheus convention for `_timestamp` metrics, so the
 * alert is `time() - retention_job_last_success_timestamp > 36 * 3600`
 * with no unit conversion to get wrong.
 *
 * @param {{ registers?: import("prom-client").Registry[] }} [options]
 */
export function createJobLastSuccessGauge({ registers } = {}) {
  return new Gauge({
    name: LAST_SUCCESS_METRIC,
    help:
      "Unix time (seconds) of each scheduled job's last successful run, read from the shared " +
      "JobRun table at scrape time so every instance reports the same value (SRS §12.3). " +
      "0 means the job has never succeeded.",
    labelNames: ["job"],
    ...(registers ? { registers } : {}),
    async collect() {
      try {
        const rows = await prisma.jobRun.findMany();
        const seen = new Map(rows.map((row) => [row.job, row.lastSuccessAt]));
        for (const job of new Set([...KNOWN_JOBS, ...seen.keys()])) {
          const at = seen.get(job);
          // 0 for a job that has NEVER succeeded, rather than leaving the
          // series absent. An absent series is the classic silent alert:
          // `time() - metric > 36h` over no data produces no result, so a
          // retention job that had never once run would never page anyone.
          // 0 makes "never" read as maximally stale, which is what it is.
          this.set({ job }, at ? Math.floor(at.getTime() / 1000) : 0);
        }
      } catch (err) {
        // A scrape during a database outage must not take the whole
        // /metrics response down with it — every other metric would vanish
        // exactly when an operator needs them. The previous values stand,
        // and the failure is logged.
        logger.warn(
          { err: { message: err instanceof Error ? err.message : String(err) } },
          "could not read job last-success times for the metrics scrape",
        );
      }
    },
  });
}

/**
 * The instance on prom-client's default registry, which step 67's
 * /metrics endpoint exposes. Looked up first, like email.js's counter, so a
 * module re-imported under vi.resetModules() does not register the same
 * name twice and throw.
 */
export const jobLastSuccessGauge =
  /** @type {Gauge<"job"> | undefined} */ (register.getSingleMetric(LAST_SUCCESS_METRIC)) ??
  createJobLastSuccessGauge();
