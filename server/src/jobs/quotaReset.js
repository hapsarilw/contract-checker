import prisma from "../lib/prisma.js";
import logger from "../observability/logger.js";
import { periodOf, periodStartOf } from "../services/quota.js";
import { readJobSuccess, recordJobSuccess } from "./jobRuns.js";
import { withJobLock } from "./lock.js";
import { startRecurring, stopRecurring } from "./scheduler.js";

/**
 * SRS §12.3's `quota-reset` — "monthly, first of month: roll monthly
 * counters."
 *
 * WHAT THERE ACTUALLY IS TO ROLL, established by reading the metering
 * code rather than assuming. The system keeps monthly usage in three
 * places, and only one of them needs a job:
 *
 *   Redis  quota:month:{user}:{YYYY-MM}    keyed by PERIOD, 62-day TTL
 *   Redis  spend:tokens:{YYYY-MM}          keyed by PERIOD, 62-day TTL
 *   Postgres  User.monthlyAnalyses + quotaPeriodStart
 *
 * The two Redis counters roll by construction: a new month is a new key,
 * the old one expires on its own, and nothing is ever zeroed. There is
 * nothing for a job to do to them, and having it "reset" them would only
 * add a way to lose a real count. (The alert-dedupe keys under
 * `spend:alerted:` are period-keyed the same way, so the 50/80/100%
 * alerts re-arm themselves at the same moment.)
 *
 * The Postgres columns are different. FR-5.1 makes them the "fallback of
 * record", but they are rolled LAZILY: quota.js's incrementDatabase resets
 * a user's count at that user's next analysis, and monthlyFromDatabase
 * reads a stale period as 0. So a user who does not analyse this month
 * keeps LAST month's count in their row until they do. Nothing in the
 * quota logic is wrong for it, but the raw row is wrong, and it is read
 * directly: FR-4.5's data export returns `monthlyAnalyses` and
 * `quotaPeriodStart` as they stand. This job makes the column true for
 * everyone at the start of the period instead of whenever each user
 * happens to come back.
 *
 * THE HOURLY LIMIT IS NOT TOUCHED, deliberately and by construction: it is
 * a Redis sorted set keyed by user, holding timestamps inside a ROLLING
 * hour (quota.js), and it has no relationship to the calendar month. This
 * job never talks to Redis at all. A test still pins that, because "the
 * job never touches Redis" is a property a later change can quietly lose.
 *
 * RACE-FREE AGAINST A LIVE ANALYSIS. The reset is one UPDATE whose WHERE
 * is `quotaPeriodStart < this period's start`. A user who has already
 * analysed this month has been lazily rolled and has quotaPeriodStart AT
 * the period start, so the WHERE excludes them and their real count is
 * not zeroed. A user rolled concurrently by incrementDatabase ends up at 1
 * whichever statement lands second, because both write the same period
 * start. Only a row still carrying an earlier period is touched, and it
 * has, by definition, nothing in the new period to lose.
 *
 * SCALE, stated: one UPDATE over every stale row. At Phase 1.5's user
 * count that is milliseconds. If the table ever grows to where that
 * statement holds row locks long enough to be felt by logins (which also
 * write to User), this becomes a batched sweep like retention.js; not
 * before, since batching is complexity bought for a problem this system
 * does not have.
 */

/** Checked hourly, so a first-of-the-month reset lands within the hour and a missed one is retried. */
export const TICK_INTERVAL_MS = 60 * 60 * 1000;

const QUOTA_RESET_LOCK_KEY = "quota-reset:monthly";

/**
 * DUE-CHECK, not "is it the first at midnight". A job that fires only if
 * an instance happens to be up at 00:00 on the 1st would skip a month
 * whenever a deploy or an outage landed on that minute. Due means "no
 * successful reset yet in THIS period", which is true from the first tick
 * of the month and stays true, being retried, until one succeeds. The
 * first ever run (no record) is due immediately.
 *
 * Compared with periodOf, the same UTC "YYYY-MM" the metering uses, so
 * "this month" means exactly what it means to the counters being reset.
 *
 * @param {Date | null} lastSuccessAt
 * @param {Date} now
 */
export function isQuotaResetDue(lastSuccessAt, now) {
  if (!lastSuccessAt) return true;
  return periodOf(lastSuccessAt) !== periodOf(now);
}

/**
 * One reset, under the advisory lock. `shouldRun` is evaluated inside the
 * lock, so the due-check and the reset are atomic across instances.
 *
 * @param {Date} [now]
 * @param {{ shouldRun?: () => Promise<boolean> }} [options]
 * @returns {Promise<{ lockAcquired: boolean, ran: boolean, reset?: number }>}
 */
export async function runQuotaReset(now = new Date(), { shouldRun } = {}) {
  const periodStart = periodStartOf(now);

  const outcome = await withJobLock(QUOTA_RESET_LOCK_KEY, async () => {
    if (shouldRun && !(await shouldRun())) return { ran: false };

    logger.info({ job: "quota-reset", period: periodOf(now) }, "quota reset started");

    const { count } = await prisma.user.updateMany({
      where: { quotaPeriodStart: { lt: periodStart } },
      data: { monthlyAnalyses: 0, quotaPeriodStart: periodStart },
    });

    await recordJobSuccess("quota-reset", now);

    // A count and a period, nothing about who: this log line has no user
    // in it and never will.
    logger.info({ job: "quota-reset", period: periodOf(now), reset: count }, "quota reset finished");
    return { ran: true, reset: count };
  });

  if (!outcome.lockAcquired) return { lockAcquired: false, ran: false };
  return { lockAcquired: true, ...outcome.value };
}

/** @param {Date} [now] */
export function quotaResetTick(now = new Date()) {
  return runQuotaReset(now, {
    shouldRun: async () => isQuotaResetDue(await readJobSuccess("quota-reset"), now),
  });
}

/**
 * @param {{ tick?: () => Promise<unknown>, intervalMs?: number }} [options]
 * @returns {NodeJS.Timeout}
 */
export function startQuotaResetJob({ tick = () => quotaResetTick(), intervalMs = TICK_INTERVAL_MS } = {}) {
  return startRecurring({ job: "quota-reset", tick, intervalMs });
}

/** @param {NodeJS.Timeout} handle */
export function stopQuotaResetJob(handle) {
  stopRecurring(handle);
}
