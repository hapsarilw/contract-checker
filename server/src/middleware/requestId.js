import { AsyncLocalStorage } from "node:async_hooks";
import { ulid } from "ulid";

const als = new AsyncLocalStorage();

// An inbound X-Request-Id is trusted for correlation only, never as an
// identity or authorization signal. Bounded so a malformed or hostile
// header can't inject an oversized value into every downstream log line.
const MAX_INBOUND_ID_LENGTH = 128;

function resolveRequestId(inboundHeader) {
  const inbound = Array.isArray(inboundHeader) ? inboundHeader[0] : inboundHeader;
  if (typeof inbound === "string" && inbound.length > 0 && inbound.length <= MAX_INBOUND_ID_LENGTH) {
    return inbound;
  }
  return ulid();
}

/**
 * SRS §6.5 — request correlation. Must be mounted before any other
 * middleware that logs (step 6 app wiring), so every log line for a
 * request — including ones emitted deep inside the extraction worker or
 * the provider call, which never see `req` directly — can reach the same
 * id via getRequestId() rather than having it threaded through every
 * function signature.
 */
export function requestIdMiddleware(req, res, next) {
  const requestId = resolveRequestId(req.headers["x-request-id"]);
  res.setHeader("X-Request-Id", requestId);
  als.run({ requestId }, () => next());
}

/**
 * Returns the current request's id, or undefined outside any request
 * context (startup code, background jobs before their own correlation
 * exists).
 *
 * It follows the ASYNC chain — promises, timers, the provider call —
 * unlike a value read off `req` inside a callback that closed over it.
 * It does NOT follow a WORKER THREAD, and that distinction cost this
 * comment its previous wording. A worker is a separate JavaScript
 * context with its own AsyncLocalStorage; nothing in the parent's store
 * is visible there, so log lines emitted inside the extraction worker
 * came out with no requestId at all — correlation missing at exactly the
 * point you most want it, since a parse that hangs or blows up is the
 * thing you are trying to trace. `runWithRequestId` below is how the id
 * crosses that boundary.
 */
export function getRequestId() {
  return als.getStore()?.requestId;
}

/**
 * Re-establishes a request context around `fn` from an id carried across
 * a boundary AsyncLocalStorage cannot cross — today, the extraction
 * worker (FR-2.11), which receives the id in its workerData and wraps
 * its work in this.
 *
 * Deliberately the same store the middleware populates, so everything
 * downstream — logger.js's mixin above all — works inside the worker
 * without knowing it is in one.
 *
 * @template T
 * @param {string | undefined} requestId
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithRequestId(requestId, fn) {
  if (!requestId) return fn();
  return als.run({ requestId }, fn);
}
