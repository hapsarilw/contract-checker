import { rateLimit } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { AppError } from "../lib/AppError.js";
import { FailurePolicyStore } from "../lib/failurePolicyStore.js";
import { getRedis } from "../lib/redis.js";
import logger from "../observability/logger.js";

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
 * STORE [step 44]: Redis, via rate-limit-redis, wrapped in
 * FailurePolicyStore. Until this step the store was the default in-memory
 * one, which keeps an independent counter PER INSTANCE — not a slower
 * version of the right answer but a different, wrong limit, since a client
 * fanning requests across N instances gets up to N× the stated ceiling and
 * a client freshly limited on instance A reads as untouched on instance B.
 * §2's second critical constraint rules that out.
 *
 * FAILURE POLICY (FR-5.6) is per limiter, not global — see the table at
 * each limiter below and the reasoning in lib/failurePolicyStore.js. The
 * short version: analysis fails CLOSED because an unmetered analyze path
 * spends money; everything else fails OPEN because an unmetered read does
 * not.
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

// Every store this module creates, so resetRateLimitsForTests() can clear
// all three without each createLimiter() call threading its store back out.
/** @type {import("../lib/failurePolicyStore.js").FailurePolicyStore[]} */
const stores = [];

/**
 * Exported so an integration test can build a SECOND limiter over the same
 * Redis and prove the counter is shared (the "limits hold across two
 * instances" requirement). Standing up a second Node process inside the
 * test run would be a heavier way to assert the same property of the store,
 * and the property belongs to the store.
 *
 * @param {{
 *   windowMs: number,
 *   limit: number,
 *   prefix: string,
 *   failurePolicy: import("../lib/failurePolicyStore.js").FailurePolicy,
 *   buildMessage: (retryTime: string) => string,
 *   keyGenerator?: (req: import("express").Request) => string,
 * }} options
 */
export function createLimiter({ windowMs, limit, prefix, failurePolicy, buildMessage, keyGenerator }) {
  // Each limiter gets its own prefix so the three buckets cannot collide
  // in one Redis database — without it, an IP's 100-request general count
  // and its 5-attempt auth count would increment the same key.
  const store = new FailurePolicyStore({
    store: new RedisStore({
      prefix,
      // rate-limit-redis types this as (...args: string[]) while ioredis's
      // `call` is (command, ...args) returning unknown. The split and the
      // cast bridge the two signatures; neither library is wrong, they just
      // describe the same raw-command call differently.
      sendCommand: (/** @type {string[]} */ ...args) =>
        /** @type {Promise<string | number | boolean | Array<string | number | boolean>>} */ (
          getRedis().call(args[0], ...args.slice(1))
        ),
    }),
    policy: failurePolicy,
    onFailure: (err, policy) => {
      logger.error(
        {
          prefix,
          policy,
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        policy === "closed"
          ? "FR-5.6: rate-limit store unavailable, refusing the request (fail closed)"
          : "FR-5.6: rate-limit store unavailable, allowing the request unmetered (fail open)",
      );
    },
  });
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
export const authLimiter = createLimiter({
  windowMs: 15 * MINUTE_MS,
  limit: 5,
  prefix: "rl:auth:",
  // FR-5.6 names only two cases — analysis and read paths — and auth is
  // neither, so this is a decision the spec left open. It fails OPEN, on
  // two grounds. PRD D13, written into FR-5.4 for the spend ceiling, sets
  // the precedent for what must survive degradation by name: "existing
  // reports, history, LOGIN, and deletion continue to work". And the cost
  // of the alternative is total: failing closed here means nobody can sign
  // in during a Redis outage, including the users trying to read a report
  // they already paid for. The trade is real and worth stating plainly —
  // while Redis is down there is no cross-request brute-force ceiling. The
  // control that should carry that weight is FR-1.10's per-ACCOUNT lockout,
  // which is keyed on the account rather than the IP and lands at step 54;
  // until then, an outage is a window, and that is an argument for step 54,
  // not for making login unavailable.
  failurePolicy: "open",
  buildMessage: (retryTime) =>
    `Too many sign-in attempts from this address. Try again in about ${retryTime}.`,
});

export const analyzeLimiter = createLimiter({
  windowMs: HOUR_MS,
  limit: 10,
  prefix: "rl:analyze:",
  // FR-5.6, the case it exists for: an unmetered analyze path is a
  // financial risk. Every call spends provider tokens, and FR-5.2 counts
  // failures too, so an outage that removed the ceiling would be billed
  // for. 503 SERVER_BUSY, not 429 — the client did nothing wrong.
  failurePolicy: "closed",
  // A `user:` prefix, not the bare id. Since step 44 the three limiters
  // share one Redis database and are separated by key prefix, so this
  // second marker is belt and braces — but it is what makes a key read
  // unambiguously in a log or a SCAN, where `rl:analyze:user:abc` says
  // what kind of identity it counts and a bare id does not.
  keyGenerator: (req) => `user:${req.auth.userId}`,
  buildMessage: (retryTime) =>
    `You've reached the limit of 10 contract analyses per hour. Try again in about ${retryTime}.`,
});

export const generalLimiter = createLimiter({
  windowMs: 15 * MINUTE_MS,
  limit: 100,
  prefix: "rl:general:",
  // Mounted on all of /api/v1, so it covers the read paths FR-5.6 names
  // AND the analyze route. Failing open here does not weaken analysis:
  // analyzeLimiter sits closer to that handler and fails closed, so an
  // outage still stops an analysis. This one failing closed would instead
  // take down history, document reads and deletion along with it.
  failurePolicy: "open",
  buildMessage: (retryTime) => `Too many requests. Try again in about ${retryTime}.`,
});

/**
 * Test-only. app.js builds one Express `app` per process, so these
 * limiters' counters persist for as long as an integration test FILE
 * imports it — across every `it()` in that file, not reset between them
 * the way tests/integration/setup.js's `afterEach` already resets the
 * database and the mock LLM provider. Without this, a test file making
 * more than 5 auth calls (a routine thing for auth.test.js to do across
 * many `it()` blocks) starts seeing 429s on requests that have nothing to
 * do with rate limiting at all.
 *
 * Since step 44 the counters live in Redis, so this is FLUSHDB against the
 * ephemeral test instance rather than an in-process reset — which is only
 * safe because that instance is created for the test run and holds nothing
 * else (tests/integration/globalSetup.js). It is deliberately NOT
 * `store.resetAll()` per limiter: rate-limit-redis implements that as a
 * SCAN over the prefix, so a leaked key under a prefix no limiter uses any
 * more would survive the reset and leak into the next test.
 *
 * Async now, and awaited by its caller — a reset that races the next test
 * is the same defect as no reset at all.
 */
export async function resetRateLimitsForTests() {
  await getRedis().flushdb();
}
