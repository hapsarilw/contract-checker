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
 * exists). Survives async boundaries — AsyncLocalStorage's context
 * follows the async chain (promises, timers, the worker/provider call),
 * unlike a value read off `req` inside a callback that closed over it.
 */
export function getRequestId() {
  return als.getStore()?.requestId;
}
