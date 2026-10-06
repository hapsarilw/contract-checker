/**
 * Whether an error means the DATABASE is unavailable for the moment, as
 * opposed to a bad query, a constraint, or a bug (BUILD-PLAN step 75).
 *
 * Before this, a database outage answered every request with INTERNAL 500
 * ("Something went wrong"): nothing to say that no data was lost, no
 * Retry-After, and indistinguishable from a defect in the logs. Now it is
 * 503 DATABASE_UNAVAILABLE (errorHandler.js), a stated degraded response
 * like the provider's LLM_UNAVAILABLE.
 *
 * MEASURED, NOT ASSUMED. With Prisma 7's pg driver adapter, a server that
 * was stopped under a live connection and a port nothing listens on both
 * surfaced as PrismaClientKnownRequestError, code P1001, with
 * meta.driverAdapterError.cause.kind "DatabaseNotReachable" (probed
 * against a real Postgres for step 75). The other kinds below are the
 * adapter's own names for the same condition reached a different way:
 * a connection dropped mid-query, a socket that timed out, a server out of
 * connections. All of them pass with time.
 *
 * NOT INCLUDED, on purpose: TlsConnectionError, AuthenticationFailed and
 * DatabaseAccessDenied. They fail every request too, but they are
 * configuration defects that no amount of waiting fixes, so telling the
 * user to try again in a minute would be untrue. They stay INTERNAL, and
 * api_5xx_rate pages on them either way.
 */

/** Prisma's error codes for an unreachable or overwhelmed database. */
const UNAVAILABLE_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

/** @prisma/adapter-pg's kinds for the same, from its own error mapping. */
const UNAVAILABLE_KINDS = new Set([
  "DatabaseNotReachable",
  "ConnectionClosed",
  "SocketTimeout",
  "TooManyConnections",
]);

/**
 * Network failures, which Prisma reports with the socket's own code on
 * `.code` and no adapter kind. The database outage drill met one: the
 * first request after Postgres stopped failed DNS (EAI_AGAIN) and answered
 * INTERNAL 500 while the 440 after it answered the stated 503. Counted ONLY
 * on a Prisma error: the same codes on a Redis or email-provider error mean
 * that dependency, not the database.
 */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isDatabaseUnavailable(err) {
  if (!err || typeof err !== "object") return false;
  const e = /** @type {{ name?: unknown, code?: unknown, meta?: any, cause?: any }} */ (
    err
  );
  if (typeof e.code === "string" && UNAVAILABLE_CODES.has(e.code)) return true;
  if (e.name === "PrismaClientInitializationError") return true;
  if (
    typeof e.name === "string" &&
    e.name.startsWith("PrismaClient") &&
    typeof e.code === "string" &&
    NETWORK_CODES.has(e.code)
  )
    return true;
  const kind = e.meta?.driverAdapterError?.cause?.kind ?? e.cause?.kind;
  return typeof kind === "string" && UNAVAILABLE_KINDS.has(kind);
}
