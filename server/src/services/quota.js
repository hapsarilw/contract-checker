import config from "../config.js";
import { AppError } from "../lib/AppError.js";
import prisma from "../lib/prisma.js";
import { getRedis } from "../lib/redis.js";
import logger from "../observability/logger.js";

/**
 * Per-user analysis quotas (SRS §3.5, FR-5.1, FR-5.2, FR-5.5).
 *
 *   hourly   HOURLY_ANALYSIS_LIMIT   (10)  rolling hour   → 429 RATE_LIMITED
 *   monthly  MONTHLY_ANALYSIS_QUOTA  (50)  calendar month → 429 QUOTA_EXCEEDED
 *
 * COUNTED IN REDIS, WITH THE DATABASE AS THE AUTHORITATIVE FALLBACK
 * (FR-5.1). Redis answers the check because it is on the request path and
 * a per-user SELECT per analysis is a cost this does not need to pay. But
 * Redis is a cache: it can be flushed, evicted, or replaced, and a quota
 * that vanished with it would be a free month. So the monthly count is
 * ALSO written to User.monthlyAnalyses, the column the schema calls the
 * "fallback of record", and the check falls back to it whenever Redis
 * cannot answer. Redis is the fast path; the database is the truth.
 *
 * The hourly count has no database fallback, deliberately. A rolling
 * hour needs per-event timestamps, which is a table this schema does not
 * have and does not want — and losing an hourly count to a Redis flush
 * costs at most a few analyses, where losing a monthly count costs a
 * month. When Redis cannot answer, the hourly limit is not enforced here;
 * FR-5.6's analyzeLimiter has already failed the request closed by then,
 * so an unmetered hour is not reachable through the API.
 *
 * WHY THE HOURLY LIMIT EXISTS HERE AS WELL AS IN analyzeLimiter, which
 * also allows 10/hour/user (NFR-2.6): the two count different things and
 * the difference shows at the window boundary. The limiter counts
 * REQUESTS in a FIXED window, so a user can spend 10 at 59:59 and 10
 * more at 1:00:01 — 20 analyses in two seconds, each window individually
 * legal. This counts terminal OUTCOMES in a ROLLING hour, which that
 * burst does exceed. The limiter is the cheap first line; this is the one
 * that means what FR-5.1 says.
 */

const HOUR_MS = 60 * 60 * 1000;

/** @param {string} userId */
const hourKey = (userId) => `quota:hour:${userId}`;
/** @param {string} userId @param {string} period */
const monthKey = (userId, period) => `quota:month:${userId}:${period}`;

/**
 * The calendar month a moment belongs to, as "YYYY-MM" in UTC.
 *
 * UTC, not local time, and that is a decision rather than a default: the
 * month a quota resets in must not depend on which region an instance
 * happens to run in, or two instances in different regions would disagree
 * about whose month it is for a day at each boundary.
 *
 * @param {Date} at
 */
export function periodOf(at) {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** First instant of the month after `at`, which is when a monthly quota resets. */
export function nextPeriodStart(at) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/** First instant of `at`'s own month. */
export function periodStartOf(at) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/**
 * How the monthly reset date reads to a user. A date, not a duration:
 * "resets on 1 October 2026" survives being read a week later, where
 * "resets in 9 days" does not.
 *
 * @param {Date} at
 */
function formatResetDate(at) {
  return nextPeriodStart(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Reads both counters without touching the database (FR-5.5: quota state
 * is inspectable by an operator without a database query).
 *
 * This is the inspection surface; the HTTP one is step 67's. §6.6 puts
 * metrics on an internal port and defines the metric set, so building an
 * endpoint here would pre-empt the step whose whole content that is —
 * and a per-user quota gauge on the public API would leak usage data
 * besides. Step 67 reads this function; nothing else needs to change.
 *
 * Returns nulls rather than zeros when Redis cannot answer — an operator
 * reading "0 analyses used" during a Redis outage would be reading a
 * fiction, and a metric that lies during an incident is worse than one
 * that admits it does not know.
 *
 * @param {string} userId
 * @param {Date} [now]
 * @returns {Promise<{ hourly: number | null, monthly: number | null, hourlyLimit: number, monthlyLimit: number, resetsAt: Date }>}
 */
export async function getQuotaState(userId, now = new Date()) {
  const base = {
    hourlyLimit: config.HOURLY_ANALYSIS_LIMIT,
    monthlyLimit: config.MONTHLY_ANALYSIS_QUOTA,
    resetsAt: nextPeriodStart(now),
  };
  try {
    const redis = getRedis();
    const [, hourly, monthly] = await redis
      .multi()
      .zremrangebyscore(hourKey(userId), 0, now.getTime() - HOUR_MS)
      .zcard(hourKey(userId))
      .get(monthKey(userId, periodOf(now)))
      .exec()
      .then((replies) => (replies ?? []).map(([, value]) => value));
    return { ...base, hourly: Number(hourly ?? 0), monthly: Number(monthly ?? 0) };
  } catch (err) {
    logger.warn(
      { err: { message: err instanceof Error ? err.message : String(err) } },
      "quota state unavailable from redis",
    );
    return { ...base, hourly: null, monthly: null };
  }
}

/**
 * The monthly count from the database — the authoritative fallback, and
 * the only place a stale period is noticed.
 *
 * A row whose quotaPeriodStart is in an earlier month has a
 * monthlyAnalyses that belongs to that earlier month. It is reported as 0
 * rather than rewritten here: this function is called on the read path,
 * and a read that writes turns a quota check into a lock-contention
 * problem on a user's own row. consumeQuota() performs the actual
 * rollover, once, as part of the increment it was going to do anyway.
 *
 * @param {string} userId
 * @param {Date} now
 */
async function monthlyFromDatabase(userId, now) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { monthlyAnalyses: true, quotaPeriodStart: true },
  });
  if (!user) return 0;
  return periodOf(user.quotaPeriodStart) === periodOf(now) ? user.monthlyAnalyses : 0;
}

/**
 * SEQUENCE STEP 2 (§2.2) — after ownership, before the PENDING insert and
 * before any provider spend.
 *
 * Throws 429 RATE_LIMITED when the rolling hour is full, or 429
 * QUOTA_EXCEEDED with the reset date when the calendar month is.
 *
 * @param {string} userId
 * @param {Date} [now]
 */
export async function assertWithinQuota(userId, now = new Date()) {
  const state = await getQuotaState(userId, now);

  if (state.hourly !== null && state.hourly >= config.HOURLY_ANALYSIS_LIMIT) {
    throw new AppError("RATE_LIMITED", {
      message: `You've reached the limit of ${config.HOURLY_ANALYSIS_LIMIT} contract analyses per hour. Try again later.`,
      retryAfter: 60,
    });
  }

  // Redis could not answer, so the database decides — the whole point of
  // FR-5.1's "authoritative fallback". Only the monthly limit has one.
  const monthly = state.monthly ?? (await monthlyFromDatabase(userId, now));

  if (monthly >= config.MONTHLY_ANALYSIS_QUOTA) {
    throw new AppError("QUOTA_EXCEEDED", {
      message:
        `You've used all ${config.MONTHLY_ANALYSIS_QUOTA} contract analyses included this month. ` +
        `Your quota resets on ${formatResetDate(now)}.`,
    });
  }
}

/**
 * SEQUENCE STEP 11 (§2.2) — FR-5.2: counters increment on EVERY terminal
 * outcome, INCLUDING FAILURES.
 *
 * This is the requirement a natural implementation gets wrong, and the
 * reason is that the obvious place for an increment is the success
 * branch. A failed provider call still consumed provider tokens, so a
 * quota that only counted successes would be a free retry loop: fail,
 * retry, fail, retry, unmetered and billed. The caller therefore invokes
 * this from a `finally`, not from the try.
 *
 * Never throws. A quota counter that could fail an analysis the user
 * already paid for would trade a billing inaccuracy for a user-visible
 * error, which is the wrong way round.
 *
 * @param {string} userId
 * @param {Date} [now]
 */
export async function consumeQuota(userId, now = new Date()) {
  await Promise.allSettled([
    incrementRedis(userId, now),
    incrementDatabase(userId, now),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        logger.error(
          { err: { message: String(result.reason?.message ?? result.reason) } },
          "quota counter increment failed — usage is undercounted for this analysis",
        );
      }
    }
  });
}

/** @param {string} userId @param {Date} now */
async function incrementRedis(userId, now) {
  const redis = getRedis();
  const ms = now.getTime();
  const period = periodOf(now);
  // A sorted set, not a counter: FR-5.1 says "rolling hour", and a rolling
  // window needs the timestamps themselves. The member is unique per call
  // so two analyses in the same millisecond are two entries rather than
  // one overwrite.
  await redis
    .multi()
    .zadd(hourKey(userId), ms, `${ms}-${Math.random().toString(36).slice(2, 10)}`)
    .zremrangebyscore(hourKey(userId), 0, ms - HOUR_MS)
    // Expiry is belt and braces: the window prune above already bounds the
    // set, but a user who stops analysing should not leave a key behind
    // forever.
    .expire(hourKey(userId), 2 * 60 * 60)
    .incr(monthKey(userId, period))
    // Two months, so the key outlives its own period and a late read
    // cannot resurrect a count that should have rolled over.
    .expire(monthKey(userId, period), 62 * 24 * 60 * 60)
    .exec();
}

/**
 * The authoritative write, and the only place the monthly period rolls
 * over. Both halves are one transaction: a rollover that reset the count
 * without moving the period, or moved the period without resetting the
 * count, would be a wrong quota rather than a missing one.
 *
 * @param {string} userId @param {Date} now
 */
async function incrementDatabase(userId, now) {
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { monthlyAnalyses: true, quotaPeriodStart: true },
    });
    if (!user) return;

    const stale = periodOf(user.quotaPeriodStart) !== periodOf(now);
    await tx.user.update({
      where: { id: userId },
      data: stale
        ? { monthlyAnalyses: 1, quotaPeriodStart: periodStartOf(now) }
        : { monthlyAnalyses: { increment: 1 } },
    });
  });
}
