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
export const KNOWN_JOBS = Object.freeze(["retention", "quota-reset", "backup-verify"]);

/**
 * Named for retention in SRS §6.6's metric table, which also gives it a
 * `job` label: it is one gauge for every scheduled job, distinguished by
 * that label, so quota-reset and backup-verify export through it rather
 * than each inventing a name Appendix C would then have to learn.
 */
export const LAST_SUCCESS_METRIC = "retention_job_last_success_timestamp";

/** Appendix C's `backup_verify_failed`: 1 while the latest check has failed, 0 otherwise. */
export const BACKUP_VERIFY_FAILED_METRIC = "backup_verify_failed";

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
 * Records a failed run WITHOUT touching lastSuccessAt: a job that
 * succeeded a week ago and failed an hour ago still has a perfectly good
 * last success, and both facts matter. `reason` is a code from a closed
 * set chosen by the caller, never free text: it is stored, logged and
 * exported, so it must never carry a path, a file name or an error message.
 *
 * @param {string} job
 * @param {Date} at
 * @param {string} reason
 */
export async function recordJobFailure(job, at, reason) {
  await prisma.jobRun.upsert({
    where: { job },
    create: { job, lastFailureAt: at, lastFailureReason: reason },
    update: { lastFailureAt: at, lastFailureReason: reason },
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
 * Everything the due-checks need about one job.
 *
 * @param {string} job
 * @returns {Promise<{ lastSuccessAt: Date | null, lastFailureAt: Date | null, lastFailureReason: string | null }>}
 */
export async function readJobRun(job) {
  const row = await prisma.jobRun.findUnique({ where: { job } });
  return {
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastFailureAt: row?.lastFailureAt ?? null,
    lastFailureReason: row?.lastFailureReason ?? null,
  };
}

/**
 * A job's latest check is failing when it has failed AND that failure is
 * newer than its last success. Pure, so the rule is tested without a
 * database.
 *
 * @param {{ lastSuccessAt: Date | null, lastFailureAt: Date | null }} run
 */
export function isFailing({ lastSuccessAt, lastFailureAt }) {
  if (!lastFailureAt) return false;
  return !lastSuccessAt || lastFailureAt > lastSuccessAt;
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
  /** @type {Gauge<"job"> | undefined} */ (
    register.getSingleMetric(LAST_SUCCESS_METRIC)
  ) ?? createJobLastSuccessGauge();

/**
 * `backup_verify_failed`, read from the same shared table for the same
 * reason as the last-success gauge: the check runs on one instance and is
 * scraped from all of them, so a flag held in the winner's memory would
 * read "fine" everywhere else and the page would never fire.
 *
 * Reports 0 when the job has never failed OR never run at all. "Never
 * ran" is not this alert's business: it is `retention_job_last_success_
 * timestamp{job="backup-verify"}` reading 0 that says so, and reporting
 * it here too would page as a backup failure something that is really a
 * scheduling problem, under the wrong runbook.
 *
 * @param {{ registers?: import("prom-client").Registry[] }} [options]
 */
export function createBackupVerifyFailedGauge({ registers } = {}) {
  return new Gauge({
    name: BACKUP_VERIFY_FAILED_METRIC,
    help:
      "1 while the most recent weekly backup verification has failed (newer than the last success), " +
      "0 otherwise. Read from the shared JobRun table at scrape time (SRS §12.3, Appendix C).",
    ...(registers ? { registers } : {}),
    async collect() {
      try {
        const run = await readJobRun("backup-verify");
        this.set(isFailing(run) ? 1 : 0);
      } catch (err) {
        // Keep the previous value rather than fail the whole scrape, and
        // say so: a stuck-at-0 page flag during a database outage is the
        // one thing worth logging loudly.
        logger.warn(
          { err: { message: err instanceof Error ? err.message : String(err) } },
          "could not read backup verification state for the metrics scrape",
        );
      }
    },
  });
}

export const backupVerifyFailedGauge =
  /** @type {Gauge | undefined} */ (
    register.getSingleMetric(BACKUP_VERIFY_FAILED_METRIC)
  ) ?? createBackupVerifyFailedGauge();
