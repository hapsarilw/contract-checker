import { getRedis } from "./redis.js";
import logger from "../observability/logger.js";

/**
 * FR-3.15 — Idempotency-Key support for POST /api/v1/documents.
 *
 * Analyze needs none of this: FR-3.8's partial unique index already makes
 * a second concurrent analyze request 409 rather than a second LLM call,
 * which is what idempotency is FOR there. Document creation has no such
 * index to lean on — two paste requests with identical text are two
 * legitimate documents, not a conflict — so a retried creation (a client
 * that timed out waiting for the first response and tried again) needs an
 * explicit mechanism instead.
 *
 * SCOPED PER USER by construction: the Redis key is built from the
 * caller's id and the header value together, so the same key string sent
 * by two different accounts is two different Redis keys and neither can
 * see or replay the other's response — there is no cross-user check to
 * get wrong.
 *
 * STORES THE WHOLE RESPONSE (status and body), not just "a document with
 * this key exists". FR-3.15 says a repeat "returns the ORIGINAL
 * response", and the only way to hand back the ORIGINAL — as opposed to a
 * freshly re-serialized one that happens to describe the same row — is to
 * have kept it.
 *
 * FAILS OPEN, matching quota.js's own Redis calls (getQuotaState) rather
 * than rateLimits.js's FailurePolicyStore: nothing here is a financial
 * control the way analyze is, and refusing document creation because the
 * idempotency CACHE is unreachable would make a Redis outage take down
 * uploads entirely for a feature whose entire job is convenience on
 * retry. The honest cost, stated rather than hidden: a retry that lands
 * during the outage window creates a second document instead of
 * replaying the first. FR-2.13's storage quota still bounds how many
 * times that can happen to any one user.
 */

/** FR-3.15's number, expressed the way the codebase already spells a day (quota.js's two-month expiry, rateLimits.js's HOUR_MS). */
const TTL_SECONDS = 24 * 60 * 60;

/** @param {string} userId @param {string} idempotencyKey */
function redisKey(userId, idempotencyKey) {
  return `idem:documents:${userId}:${idempotencyKey}`;
}

/**
 * The stored response for a previous request under this key, or null if
 * there isn't one (never used, expired, or Redis could not be asked).
 *
 * @param {string} userId
 * @param {string} idempotencyKey
 * @returns {Promise<{ status: number, body: unknown } | null>}
 */
export async function findIdempotentResponse(userId, idempotencyKey) {
  try {
    const raw = await getRedis().get(redisKey(userId, idempotencyKey));
    if (!raw) return null;
    // A malformed value (there should never be one) is treated the same
    // as no value — the request proceeds and creates a document — rather
    // than surfacing a 500 for a cache-format problem on the read path.
    return JSON.parse(raw);
  } catch (err) {
    logger.warn(
      { err: { message: err instanceof Error ? err.message : String(err) } },
      "idempotency lookup failed, proceeding as a fresh request",
    );
    return null;
  }
}

/**
 * Records the response a request under this key produced, for 24 hours.
 * AWAITED by the caller (documents.js), unlike the email queue: the
 * client cannot retry before it has received this response, so nothing
 * is lost by finishing the write first — and not awaiting it would
 * reopen exactly the "200 before the row exists" race step 56 already
 * found once with the audit trail.
 *
 * @param {string} userId
 * @param {string} idempotencyKey
 * @param {number} status
 * @param {unknown} body
 */
export async function storeIdempotentResponse(userId, idempotencyKey, status, body) {
  try {
    await getRedis().set(
      redisKey(userId, idempotencyKey),
      JSON.stringify({ status, body }),
      "EX",
      TTL_SECONDS,
    );
  } catch (err) {
    // Best-effort. A request that succeeded stays succeeded even if the
    // cache write failed — the cost is that ITS OWN retry, specifically,
    // will create a second document, not that this request's response is
    // wrong.
    logger.warn(
      { err: { message: err instanceof Error ? err.message : String(err) } },
      "idempotency store failed — a retry of this request will create a duplicate document",
    );
  }
}

/**
 * HTTP header names arrive lowercased on `req.headers`; this is the one
 * place that string is spelled, so a typo cannot exist in two places
 * disagreeing with each other.
 */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * A generous bound with no basis in FR-3.15, which sets none — this exists
 * only so an arbitrarily large header value never becomes a Redis key.
 * Exported so its own unit test can assert the exact boundary instead of
 * duplicating the number.
 */
export const MAX_KEY_LENGTH = 256;

/**
 * Reads and bounds-checks the header. Returns null for "no key" (the
 * header was absent, blank, or unreasonably long) rather than throwing —
 * an oversized or missing key is not a client error FR-3.15 asks this
 * route to report; it is simply a request with no idempotency key, same
 * as one that never set the header.
 *
 * @param {import("express").Request} req
 * @returns {string | null}
 */
export function readIdempotencyKey(req) {
  const value = req.headers[IDEMPOTENCY_KEY_HEADER];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_LENGTH) return null;
  return trimmed;
}
