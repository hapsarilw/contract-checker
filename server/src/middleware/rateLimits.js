import { rateLimit, MemoryStore } from "express-rate-limit";
import { AppError } from "../lib/AppError.js";

/**
 * BUILD-PLAN step 41 (OPS-2) / NFR-2.6 — the three Phase 1 rate-limit
 * buckets, wired into the slot app.js (step 6) left for them:
 *
 *   - authLimiter:    5 auth attempts  / 15 min / IP   (auth.js: register, login)
 *   - analyzeLimiter: 10 analyses      / hour   / USER (documents.js: POST .../analyze)
 *   - generalLimiter: 100 requests     / 15 min / IP   (app.js: all of /api/v1)
 *
 * They stack, deliberately: a login flood hits BOTH authLimiter (5/15min)
 * and generalLimiter (100/15min) since generalLimiter is mounted on the
 * whole /api/v1 prefix — the general bucket is a blanket ceiling across
 * everything, the other two are tighter, route-specific ones layered on
 * top of it. None of the three cover FR-1.10's per-ACCOUNT lockout or
 * §3.5's monthly quotas — different limits, different keys, different
 * steps.
 *
 * STORE: express-rate-limit's own default MemoryStore — left implicit
 * below by never passing a `store` option. §2.1 marks the store choice
 * itself [P1.5]: the API runs as TWO OR MORE stateless instances (§2's
 * second critical constraint), and a memory store keeps an independent
 * counter PER INSTANCE. That is INCORRECT the moment the fleet grows
 * past one — a client fanning requests across instances gets up to N×
 * the stated limit, and a client freshly rate-limited on instance A
 * reads as untouched on instance B, because instance B never saw those
 * requests. Every limiter below is built by the one `buildLimiter`
 * factory specifically so step 44's swap to a Redis-backed store is:
 *
 *   store: new RedisStore({ sendCommand: (...args) => redisClient.call(...args) }),
 *
 * added once, inside `buildLimiter`, rather than three separate edits
 * that could drift out of sync with each other.
 *
 * KEYING — the instruction this step calls out as the single most
 * common way IP limits go wrong for every user at once: app.js (step 6)
 * already runs `app.set('trust proxy', 1)`, which is what makes
 * Express's own `request.ip` the real client address rather than the
 * platform proxy's. authLimiter and generalLimiter deliberately do NOT
 * set a custom `keyGenerator` — express-rate-limit's own default reads
 * `request.ip`, and hand-rolling that would mean reimplementing its
 * IPv6-subnet handling (`ipKeyGenerator()`) to avoid a trivial bypass,
 * which the library's default already does correctly. analyzeLimiter's
 * keyGenerator IS custom, because NFR-2.6 keys it on something that
 * isn't an IP at all — it must run after `requireAuth` populates
 * `req.auth`, which is why documents.js mounts it there and not before.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * @param {Date | undefined} resetTime
 * @returns {number}
 */
function retryAfterSeconds(resetTime) {
  // Only absent if express-rate-limit's own store returns no resetTime,
  // which the MemoryStore this file uses never does — a defensive
  // fallback, not a case this module expects to hit.
  if (!resetTime) return 60;
  return Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / SECOND_MS));
}

/**
 * NFR-4.3 / this step's own instruction ("a message stating when to
 * retry"): relative phrasing ("in about 8 minutes"), matching how every
 * other retryable error in errorCodes.js already states its wait
 * ("in about a minute", "in a few seconds") rather than a clock time the
 * client would have to convert against its own timezone.
 *
 * @param {number} totalSeconds
 * @returns {string}
 */
function humanizeRetryTime(totalSeconds) {
  if (totalSeconds < 90) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.ceil(totalSeconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

// Every store this module creates, so resetRateLimitsForTests() (bottom
// of this file) can clear all three without each buildLimiter() call
// having to thread its store back out individually.
const stores = [];

/**
 * @param {{
 *   windowMs: number,
 *   limit: number,
 *   buildMessage: (retryTime: string) => string,
 *   keyGenerator?: (req: import("express").Request) => string,
 * }} options
 */
function buildLimiter({ windowMs, limit, buildMessage, keyGenerator }) {
  // Constructed explicitly, rather than left for rateLimit() to create
  // implicitly, ONLY so resetRateLimitsForTests() has a handle to reset
  // — express-rate-limit's own default behaviour is identical either
  // way. (validate.js's `ERR_ERL_STORE_REUSE` check is why this can't be
  // one shared store across all three limiters: each needs its own.)
  const store = new MemoryStore();
  stores.push(store);

  return rateLimit({
    windowMs,
    limit,
    store,
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    // AppError -> the shared errorHandler (step 6), not a response
    // written directly here — SRS §4 is emphatic that every error
    // "follows one shape," and that shape (plus the Retry-After header,
    // errorHandler.js) is produced in exactly one place already.
    handler: (req, res, next) => {
      const seconds = retryAfterSeconds(req.rateLimit?.resetTime);
      next(
        new AppError("RATE_LIMITED", {
          message: buildMessage(humanizeRetryTime(seconds)),
          retryAfter: seconds,
        }),
      );
    },
  });
}

// One shared instance — auth.js mounts THIS SAME middleware on both
// /register and /login, deliberately, so the two routes share one
// combined counter per IP rather than 5 attempts on each (10 total):
// "5 auth attempts" (NFR-2.6) reads as any authentication attempt, and
// splitting the count per-route would let an attacker double the
// effective ceiling just by alternating between the two endpoints.
export const authLimiter = buildLimiter({
  windowMs: 15 * MINUTE_MS,
  limit: 5,
  buildMessage: (retryTime) =>
    `Too many sign-in attempts from this address. Try again in about ${retryTime}.`,
});

export const analyzeLimiter = buildLimiter({
  windowMs: HOUR_MS,
  limit: 10,
  // A `user:` prefix, not the bare id — this limiter's MemoryStore is
  // never shared with the IP-keyed ones (each buildLimiter() call gets
  // its own store instance), so this guards nothing today, but it keeps
  // a key dumped in a log or a future shared store unambiguous about
  // what kind of identity it is.
  keyGenerator: (req) => `user:${req.auth.userId}`,
  buildMessage: (retryTime) =>
    `You've reached the limit of 10 contract analyses per hour. Try again in about ${retryTime}.`,
});

export const generalLimiter = buildLimiter({
  windowMs: 15 * MINUTE_MS,
  limit: 100,
  buildMessage: (retryTime) => `Too many requests. Try again in about ${retryTime}.`,
});

/**
 * Test-only. app.js builds one Express `app` per process, so these
 * limiters' in-memory counters persist for as long as an integration
 * test FILE imports it — across every `it()` in that file, not reset
 * between them the way tests/integration/setup.js's `afterEach` already
 * resets the database and the mock LLM provider. Without this, a test
 * file making more than 5 auth calls (a routine thing for auth.test.js
 * to do across many `it()` blocks) starts seeing 429s on requests that
 * have nothing to do with rate limiting at all. Wired into that same
 * `afterEach` (tests/integration/setup.js) rather than called ad hoc
 * per file, matching how the database reset is handled.
 *
 * Only meaningful against MemoryStore, today's only store — a future
 * Redis-backed store (step 44) would need its own equivalent, most
 * likely FLUSHDB against a dedicated test Redis instance.
 */
export function resetRateLimitsForTests() {
  for (const store of stores) store.resetAll();
}
