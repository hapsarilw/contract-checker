import Redis from "ioredis";
import config from "../config.js";
import logger from "../observability/logger.js";

/**
 * The Redis client (SRS §2's second critical constraint, §3.5, FR-5.6).
 *
 * The API runs as two or more stateless instances, so anything that counts
 * — rate limits now, quota and spend counters at steps 45 and 46 — has to
 * live outside any one process. A per-instance counter is not a slower
 * version of a correct one; it is a different, wrong limit, since a client
 * fanning requests across N instances gets up to N times the stated ceiling.
 *
 * CONSTRUCTED ON FIRST USE, not at import. This mirrors getLlmProvider()
 * (services/llm/index.js) for the same reason: importing this module must
 * not open a socket. Unit tests are defined as "no database, no network, no
 * container" (§10), and scripts/benchmark.js imports config transitively
 * without needing Redis at all. Nothing connects until a request actually
 * reaches a limiter.
 *
 * WHY THESE OPTIONS. FR-5.6 turns a Redis failure into a deliberate
 * per-limiter decision, which only works if the failure ARRIVES — a
 * command that hangs is a request that hangs, whatever the policy says.
 * The numbers below were measured against this ioredis version rather than
 * reasoned about, because the first arrangement tried here was wrong:
 *
 *   maxRetriesPerRequest: 1 — what actually bounds the failure. Against a
 *     refused port, a command rejects in ~200 ms once the retry budget is
 *     spent. After an explicit disconnect it rejects in ~1 ms. This, not
 *     commandTimeout, is the mechanism that bounds a command waiting on a
 *     connection that is not there.
 *   enableOfflineQueue — LEFT AT ITS DEFAULT (true), deliberately, after
 *     `false` was tried and rejected. With the queue off, rate-limit-redis
 *     fails at construction: its `init` loads a Lua script the moment a
 *     limiter is built, which is before any connection exists, so every
 *     limiter in this file threw at import even with Redis healthy. The
 *     queue is what lets that first command wait for the connection it
 *     needs; maxRetriesPerRequest is what stops it waiting forever.
 *   commandTimeout / connectTimeout — NFR-3.7: every outbound dependency
 *     call has an explicit timeout. These cover the case the retry budget
 *     does not, where Redis accepts the write and never answers — a
 *     half-open connection looks healthy to the reconnect logic.
 */

/** NFR-3.7. Deliberately short: this sits in front of every request. */
const CONNECT_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 1_000;

/** @type {import("ioredis").Redis | undefined} */
let client;

/**
 * Reconnection backoff. Capped so a long outage settles into a steady
 * retry rather than drifting into effectively-never, and jittered so a
 * fleet restarting after a Redis failure does not reconnect in lockstep.
 *
 * @param {number} attempt
 * @returns {number}
 */
export function reconnectDelayMs(attempt) {
  const base = Math.min(attempt * 200, 2_000);
  return base + Math.floor(Math.random() * 100);
}

/** The process-wide client, created on first use. */
export function getRedis() {
  if (client) return client;

  client = new Redis(config.REDIS_URL, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: reconnectDelayMs,
  });

  // An 'error' event with no listener is an UNCAUGHT exception on an
  // EventEmitter, so a Redis outage would take the process down — the
  // opposite of FR-5.6, which is about degrading rather than dying. Logged
  // at warn, not error: the connection failing is expected input to the
  // policy below it, and the limiter's own decision is what deserves an
  // error line.
  client.on("error", (err) => {
    logger.warn(
      { err: { type: err.name, message: err.message } },
      "redis connection error",
    );
  });

  return client;
}

/**
 * FR-4.7 readiness. Uses the same client and the same timeouts as the
 * request path, so a readiness check cannot pass on a connection the
 * limiters would find unusable.
 *
 * @returns {Promise<void>}
 */
export async function pingRedis() {
  await getRedis().ping();
}

/**
 * Graceful shutdown (FR-4.6). `quit()` lets in-flight commands finish;
 * a failure here is logged rather than thrown, because refusing to exit
 * over a dependency that is already unreachable helps nobody.
 */
export async function closeRedis() {
  if (!client) return;
  try {
    await client.quit();
  } catch (err) {
    logger.warn(
      { err: { message: /** @type {Error} */ (err).message } },
      "redis quit failed, forcing disconnect",
    );
    client.disconnect();
  }
  client = undefined;
}

/** Test-only: drops the memoised client so a test can build a fresh one. */
export function resetRedisForTests() {
  client = undefined;
}
