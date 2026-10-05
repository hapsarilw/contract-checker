import { AppError } from "../lib/AppError.js";
import { ERROR_CODES, DEFAULT_RETRY_AFTER_SECONDS } from "../lib/errorCodes.js";
import logger from "../observability/logger.js";
import { reportError } from "../observability/errorTracker.js";
import { routeLabel } from "../observability/metrics.js";
import { getRequestId } from "./requestId.js";

/**
 * SRS §4 / NFR-3.2 — the global error handler. Must be the LAST
 * middleware registered (app.js, step 6): Express only routes to an
 * error handler that comes after the middleware/route that called
 * next(err).
 *
 * Response shape is exactly `{ error: { code, message, requestId } }` —
 * §4 is emphatic that errors "follow one shape." AppError's `details` is
 * for server-side logging only and never reaches this response.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity (4 params); `next` must stay in the signature even though this handler never calls it.
export function errorHandler(err, req, res, next) {
  const isAppError = err instanceof AppError;
  const code = isAppError ? err.code : "INTERNAL";
  const status = isAppError ? err.status : ERROR_CODES.INTERNAL.status;
  const message = isAppError ? err.message : ERROR_CODES.INTERNAL.message;
  const requestId = getRequestId();

  const logPayload = { err, code, status, requestId };
  if (status >= 500) {
    logger.error(logPayload, "request failed");
    // Step 74: to the error tracker, with the route PATTERN and nothing else
    // about the request (observability/errorTracker.js says why).
    reportError(err, {
      method: req.method,
      route: routeLabel(req),
      path: (req.originalUrl ?? req.url ?? "").split("?")[0],
      requestId,
    });
  } else {
    // Expected failures (validation, auth, quota, ...) are noise at error
    // level — SRS §6.5 reserves `error` for failures needing a human.
    logger.warn(logPayload, "request failed");
  }

  // Every 503 carries Retry-After unconditionally (SRS §4.2's closing
  // note), falling back to DEFAULT_RETRY_AFTER_SECONDS if a future 503
  // code ships with no value of its own. A NON-503 code carries it only
  // when a call site explicitly set one via AppError's `retryAfter`
  // option — step 41's rate limiters do exactly that on 429 RATE_LIMITED,
  // with the real, precise seconds-until-the-window-resets rather than a
  // guess; errorCodes.js's own static table intentionally has no
  // RATE_LIMITED default; there is nothing meaningful to default to for
  // a per-request rate-limit window without a window in front of it.
  if (status === 503 || (isAppError && err.retryAfter)) {
    const retryAfter = (isAppError && err.retryAfter) || DEFAULT_RETRY_AFTER_SECONDS;
    res.set("Retry-After", String(retryAfter));
  }

  res.status(status).json({ error: { code, message, requestId } });
}
