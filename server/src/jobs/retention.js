import config from "../config.js";
import prisma from "../lib/prisma.js";
import logger from "../observability/logger.js";
import { readJobSuccess, recordJobSuccess } from "./jobRuns.js";
import { startRecurring, stopRecurring } from "./scheduler.js";

/**
 * FR-4.4 / SRS §5.6 / PRD §12.4 — the retention job.
 *
 * WHAT IT ENFORCES, and why it has to be a job rather than an intention.
 * PRD §12.4 PUBLISHES a retention window: document text and its analyses
 * for 90 days from upload. That is a promise in a privacy policy, not an
 * internal preference, and FR-4.4 says what happens to a promise nobody
 * enforces: "an unmonitored retention job is a policy that quietly stops
 * being true." The §5.6 table, all three rows this job owns:
 *
 *   Documents and descendants   RETENTION_DAYS (90) from createdAt
 *   Expired AuthToken rows      7 days past expiresAt
 *   AuditEvent rows             13 months from createdAt
 *
 * Descendants — analyses and findings — go with their document through the
 * schema's own ON DELETE CASCADE, not through a second delete here. §5.6
 * is explicit that cascades are declared in the schema "so deletion cannot
 * be partially implemented by an application that forgets a table," and a
 * hand-written child delete in this file would be exactly that second,
 * weaker copy of the rule.
 *
 * LOGS COUNTS ONLY. Never a document id, a filename, a user, a line of
 * text. The log line for a retention run must be safe to paste into a
 * public incident report.
 */

/** §5.6's batch size. */
export const BATCH_SIZE = 500;

/** §5.6: expired tokens are kept a week past expiry, then removed. */
export const AUTH_TOKEN_GRACE_DAYS = 7;

/** §5.6: the audit trail is kept thirteen months. */
export const AUDIT_RETENTION_MONTHS = 13;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * WHEN "NIGHTLY" RUNS, and why it is a due-check rather than a 24-hour
 * timer. A `setInterval(24h)` restarts from zero on every deploy — on a
 * service that deploys more than once a day it would never fire at all,
 * and nothing would notice until the 36-hour alert. So every instance
 * instead asks every 15 minutes whether the job is DUE, reading the last
 * success from the shared JobRun table:
 *
 *   never run                       -> due now
 *   ran < 12 h ago                  -> not due
 *   ran 12-30 h ago, inside window  -> due
 *   ran >= 30 h ago                 -> due now, window or not
 *
 * The window is 02:00-06:00 UTC, the off-peak hours for the delete load.
 * The 12-hour floor is what keeps the job to one run per night: the window
 * is four hours wide, so no two runs can share it, and even the latest
 * possible run (just before 06:00) is 20 hours before the next window
 * opens, comfortably past the floor, so the following night always
 * qualifies. The 30-hour catch-up exists for the night every
 * instance was down: it runs the job in the daytime rather than let the
 * published window lapse, and it fires six hours before the 36-hour alert
 * would. After a catch-up, the 12-hour floor lets the very next window
 * qualify again, so the job drifts back to night on its own instead of
 * settling into a 30-hour daytime cycle.
 */
export const TICK_INTERVAL_MS = 15 * 60 * 1000;
export const MIN_INTERVAL_MS = 12 * HOUR_MS;
export const CATCH_UP_AFTER_MS = 30 * HOUR_MS;
export const NIGHTLY_WINDOW_UTC = Object.freeze({ startHour: 2, endHour: 6 });

/**
 * How long the transaction that HOLDS the advisory lock may stay open. It
 * does no work of its own — see runRetention — so this only has to outlast
 * the run. Past it, Prisma rolls the lock transaction back, the lock is
 * released, and a second instance could start alongside the first. That
 * would be wasted work rather than damage: every delete here is
 * idempotent, and a row cannot be deleted twice.
 */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

const RETENTION_LOCK_KEY = "retention:nightly";

/**
 * Pure. See the table above NIGHTLY_WINDOW_UTC.
 *
 * @param {Date | null} lastSuccessAt
 * @param {Date} now
 */
export function isDue(lastSuccessAt, now) {
  if (!lastSuccessAt) return true;
  const elapsed = now.getTime() - lastSuccessAt.getTime();
  if (elapsed >= CATCH_UP_AFTER_MS) return true;
  if (elapsed < MIN_INTERVAL_MS) return false;
  const hour = now.getUTCHours();
  return hour >= NIGHTLY_WINDOW_UTC.startHour && hour < NIGHTLY_WINDOW_UTC.endHour;
}

/**
 * `date` minus `months` calendar months, in UTC, with the day clamped to
 * the end of a shorter month: 31 March minus one month is 28 (or 29)
 * February, not 3 March. The clamp errs toward KEEPING an audit row a few
 * days longer at a month boundary, which is the safe direction for
 * evidence.
 *
 * @param {Date} date
 * @param {number} months
 */
export function subtractMonthsUTC(date, months) {
  const target = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() - months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDayOfTargetMonth));
  return target;
}

/**
 * Every cutoff is strictly OLDER-THAN: a document exactly RETENTION_DAYS
 * old is kept until the next run.
 *
 * @param {Date} now
 */
export function cutoffsFor(now) {
  return {
    documents: new Date(now.getTime() - config.RETENTION_DAYS * DAY_MS),
    authTokens: new Date(now.getTime() - AUTH_TOKEN_GRACE_DAYS * DAY_MS),
    auditEvents: subtractMonthsUTC(now, AUDIT_RETENTION_MONTHS),
  };
}

/**
 * Deletes every row matching `where`, `batchSize` at a time, oldest first.
 *
 * WHY BATCHES (§5.6). One unbounded DELETE over a month of documents is one
 * long transaction holding row locks on all of them, and — through the
 * cascade — on every analysis and finding under them, while live requests
 * are trying to read those tables. 500 at a time keeps each statement
 * short and lets live traffic interleave.
 *
 * Each batch is SELECT ids, then DELETE those ids, because Postgres's
 * DELETE has no LIMIT. The SELECT orders by the same column the `where`
 * filters on, so it walks the index that column already has
 * (Document.createdAt, AuthToken.expiresAt, AuditEvent.createdAt).
 *
 * The DELETE re-states `where` alongside the id list. The ids already
 * satisfy it, so this costs nothing — but it means a mismatch between what
 * a caller selects and what it deletes can only ever delete LESS, never
 * something outside the retention rule.
 *
 * @param {{ findMany: Function, deleteMany: Function }} model a Prisma delegate
 * @param {object} where
 * @param {string} orderField
 * @param {number} batchSize
 * @returns {Promise<{ deleted: number, batches: number }>}
 */
async function deleteInBatches(model, where, orderField, batchSize) {
  let deleted = 0;
  let batches = 0;
  for (;;) {
    const rows = await model.findMany({
      where,
      select: { id: true },
      orderBy: { [orderField]: "asc" },
      take: batchSize,
    });
    if (rows.length === 0) break;

    const { count } = await model.deleteMany({
      where: { AND: [where, { id: { in: rows.map((row) => row.id) } }] },
    });
    batches += 1;
    deleted += count;

    // A short batch was the last one. And a batch that deleted nothing —
    // every selected row removed by someone else in between — ends the run
    // rather than risking a loop that selects the same ids forever; the
    // next run picks up whatever is left.
    if (rows.length < batchSize || count === 0) break;
  }
  return { deleted, batches };
}

/**
 * One retention run, under the advisory lock.
 *
 * THE LOCK IS HELD BY A TRANSACTION THAT DOES NO WORK. The deletes run
 * OUTSIDE it, on the ordinary client, each batch committing on its own.
 * That separation is the whole design: `pg_try_advisory_xact_lock` is
 * released when its transaction ends, so the lock has to live in a
 * transaction that spans the run — but if the deletes ran INSIDE that
 * transaction, the entire night's deletion would be one giant transaction
 * and the batching would bound nothing. So one connection sits in an open
 * transaction holding the lock, and the batches commit around it. If the
 * process dies mid-run, that connection dies with it and Postgres releases
 * the lock; every batch already committed stays deleted, and the next run
 * continues from there.
 *
 * `shouldRun` is evaluated INSIDE the lock, so the due-check and the run
 * are atomic across instances: an instance that read "due" a moment
 * before another finished cannot then take the lock and run the same
 * night twice.
 *
 * @typedef {{ deleted: number, batches: number }} Sweep
 * @typedef {{ lockAcquired: boolean, ran: boolean, documents?: Sweep, authTokens?: Sweep, auditEvents?: Sweep }} RetentionResult
 *
 * @param {Date} [now]
 * @param {{ batchSize?: number, shouldRun?: () => Promise<boolean> }} [options]
 * @returns {Promise<RetentionResult>}
 */
export async function runRetention(now = new Date(), { batchSize = BATCH_SIZE, shouldRun } = {}) {
  const cutoffs = cutoffsFor(now);

  return prisma.$transaction(
    async (lockTx) => {
      const [{ locked }] = /** @type {[{ locked: boolean }]} */ (
        await lockTx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${RETENTION_LOCK_KEY})) AS locked`
      );
      if (!locked) return { lockAcquired: false, ran: false };
      if (shouldRun && !(await shouldRun())) return { lockAcquired: true, ran: false };

      logger.info({ job: "retention" }, "retention run started");

      const documents = await deleteInBatches(
        prisma.document,
        { createdAt: { lt: cutoffs.documents } },
        "createdAt",
        batchSize,
      );
      const authTokens = await deleteInBatches(
        prisma.authToken,
        { expiresAt: { lt: cutoffs.authTokens } },
        "expiresAt",
        batchSize,
      );
      const auditEvents = await deleteInBatches(
        prisma.auditEvent,
        { createdAt: { lt: cutoffs.auditEvents } },
        "createdAt",
        batchSize,
      );

      // Recorded while the lock is still held, so no other instance can
      // see "due" in the gap between this run finishing and the record
      // saying so. On the ordinary client, like the deletes: it must
      // survive even if the lock transaction itself fails to commit.
      await recordJobSuccess("retention", now);

      const result = { lockAcquired: true, ran: true, documents, authTokens, auditEvents };
      logger.info(
        { job: "retention", documents, authTokens, auditEvents },
        "retention run finished",
      );
      return result;
    },
    { timeout: RUN_TIMEOUT_MS, maxWait: 10_000 },
  );
}

/**
 * One scheduler tick: run if due, decided inside the lock.
 *
 * @param {Date} [now]
 */
export function retentionTick(now = new Date()) {
  return runRetention(now, {
    shouldRun: async () => isDue(await readJobSuccess("retention"), now),
  });
}

/**
 * @param {{ tick?: () => Promise<unknown>, intervalMs?: number }} [options]
 * @returns {NodeJS.Timeout} pass to `stopRetentionJob` to cancel
 */
export function startRetentionJob({ tick = () => retentionTick(), intervalMs = TICK_INTERVAL_MS } = {}) {
  return startRecurring({ job: "retention", tick, intervalMs });
}

/** @param {NodeJS.Timeout} handle */
export function stopRetentionJob(handle) {
  stopRecurring(handle);
}
