import { AppError } from "../lib/AppError.js";
import prisma from "../lib/prisma.js";

/**
 * FR-1.10 — account lockout.
 *
 * "After 10 consecutive failed logins for one account within 15 minutes,
 *  further attempts for that account return 429 ACCOUNT_LOCKED with a
 *  stated retry time, for 15 minutes, REGARDLESS OF SOURCE IP."
 *
 * WHY THIS IS NOT THE RATE LIMITER. NFR-2.6 already caps auth attempts at
 * 5 per 15 minutes per IP, and it is easy to read this as the same control
 * twice. It is not: the limiter bounds what one ADDRESS can do, and an
 * attacker with a botnet simply spreads the attempt across addresses, each
 * one comfortably under the limit while the account takes thousands of
 * guesses. This bounds what one ACCOUNT can suffer, which is the property
 * a distributed attempt cannot dodge. That is why TR-11 insists the locked
 * attempt come from a DIFFERENT IP than the ten failures — from the same
 * IP the per-IP limiter answers first and the test proves nothing.
 *
 * WHY THE STATE IS IN POSTGRES AND NOT REDIS, which is the opposite of the
 * call made for rate limits at step 44. A rate limit degrades: FR-5.6 lets
 * it fail open on read paths because an unmetered history page costs
 * little. This is the control standing between a password and an account,
 * and it has no acceptable failure mode. Fail open and a Redis blip is an
 * unlimited guessing window; fail closed and a Redis blip locks every user
 * out. The database is where the user row already lives, the request
 * already loads it, and it is as durable as the account itself.
 *
 * THE UNLOCK IS AUTOMATIC. PRD §8.1 designs the support ticket out
 * deliberately: a lockout that needs a human to clear it converts a
 * failed attack into a successful denial of service, and puts the person
 * who was attacked in a queue.
 */

export const MAX_FAILED_ATTEMPTS = 10;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;

/** @param {Date} until @param {Date} now */
function retryAfterSeconds(until, now) {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
}

/** @param {number} seconds */
function humanize(seconds) {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? "a minute" : `${minutes} minutes`;
}

/**
 * Throws 429 ACCOUNT_LOCKED while a lock is in force.
 *
 * Called with the user row the login path has already loaded, so it costs
 * no extra query. Takes `null` for an unknown email and does nothing —
 * locking is meaningless without an account, and FR-1.6 requires the
 * unknown-email path to stay indistinguishable from a wrong password.
 *
 * @param {{ lockedUntil: Date | null } | null} user
 * @param {Date} [now]
 */
export function assertNotLockedOut(user, now = new Date()) {
  if (!user?.lockedUntil || user.lockedUntil <= now) return;

  const seconds = retryAfterSeconds(user.lockedUntil, now);
  throw new AppError("ACCOUNT_LOCKED", {
    message: `Too many failed sign-in attempts. Try again in about ${humanize(seconds)}.`,
    retryAfter: seconds,
  });
}

/**
 * Records a failed attempt and locks the account on the tenth within the
 * window.
 *
 * ONE STATEMENT, and the window arithmetic happens in SQL rather than in
 * JavaScript, because read-then-write is a race: ten simultaneous guesses
 * would each read the same count and each write count+1, so the account
 * would sit at 1 while ten attempts went through. A conditional UPDATE
 * that derives the new values from the row's current ones cannot be
 * interleaved that way — and a distributed attack is precisely the case
 * where the attempts ARE simultaneous, so this is not a theoretical race.
 *
 * The window restarts when the previous run of failures has gone stale:
 * ten typos spread over a year are not an attack, and treating them as
 * one hands an attacker a slow denial of service against a real user.
 *
 * @param {string} userId
 * @param {Date} [now]
 * @returns {Promise<{ locked: boolean }>}
 */
export async function recordFailedLogin(userId, now = new Date()) {
  const windowStart = new Date(now.getTime() - WINDOW_MS);
  const lockUntil = new Date(now.getTime() + LOCKOUT_MS);

  const rows = await prisma.$queryRaw`
    UPDATE "User"
    SET
      "failedLoginCount" = CASE
        WHEN "firstFailedLoginAt" IS NULL OR "firstFailedLoginAt" < ${windowStart}
          THEN 1
        ELSE "failedLoginCount" + 1
      END,
      "firstFailedLoginAt" = CASE
        WHEN "firstFailedLoginAt" IS NULL OR "firstFailedLoginAt" < ${windowStart}
          THEN ${now}
        ELSE "firstFailedLoginAt"
      END,
      "lockedUntil" = CASE
        WHEN "firstFailedLoginAt" IS NOT NULL
             AND "firstFailedLoginAt" >= ${windowStart}
             AND "failedLoginCount" + 1 >= ${MAX_FAILED_ATTEMPTS}
          THEN ${lockUntil}
        ELSE "lockedUntil"
      END
    WHERE "id" = ${userId}
    RETURNING "lockedUntil" AS "lockedUntil"
  `;

  const lockedUntil =
    /** @type {{ lockedUntil: Date | null }[]} */ (rows)[0]?.lockedUntil ?? null;
  return { locked: Boolean(lockedUntil && lockedUntil > now) };
}

/**
 * Clears the counters after a successful sign-in — FR-1.10's "the counter
 * resets on success".
 *
 * Skipped when there is nothing to clear, which is the overwhelmingly
 * common case: an unconditional write would touch the user row on every
 * single login for no reason.
 *
 * @param {{ id: string, failedLoginCount: number, lockedUntil: Date | null, firstFailedLoginAt?: Date | null }} user
 */
export async function clearFailedLogins(user) {
  if (user.failedLoginCount === 0 && !user.lockedUntil && !user.firstFailedLoginAt)
    return;
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, firstFailedLoginAt: null, lockedUntil: null },
  });
}
