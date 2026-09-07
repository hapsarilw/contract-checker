import { lookupErrorCode } from "./errorCodes.js";

/**
 * The one error type application code should throw for any expected,
 * named failure (SRS §4.2). Status is always derived from the code table
 * — never passed in — so a response code and its HTTP status can never
 * drift apart at a call site.
 *
 * `details` is for server-side use only (logging, deciding what message
 * to construct) — it is never serialized into the client response.
 * SRS §4's error shape is exactly `{ code, message, requestId }`; nothing
 * else survives to the wire.
 */
export class AppError extends Error {
  /**
   * @param {keyof typeof import("./errorCodes.js").ERROR_CODES} code
   * @param {{ message?: string, details?: unknown, retryAfter?: number }} [options]
   */
  constructor(code, { message, details, retryAfter } = {}) {
    const entry = lookupErrorCode(code);
    if (!entry) {
      // A typo'd or made-up code is a bug at the call site, not a runtime
      // condition — fail immediately and loudly rather than letting it
      // surface later as a confusing 500 with the wrong shape.
      throw new Error(`AppError: unknown error code "${code}" — not in errorCodes.js`);
    }

    super(message ?? entry.message);
    this.name = "AppError";
    this.code = code;
    this.status = entry.status;
    this.details = details;
    this.retryAfter = retryAfter ?? entry.retryAfter;

    Error.captureStackTrace?.(this, AppError);
  }
}
