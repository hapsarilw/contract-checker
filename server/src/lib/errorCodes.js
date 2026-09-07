/**
 * SRS §4.2 — the complete error-code table, as data. This is the single
 * source of truth the OpenAPI contract test (step 59) asserts against, so
 * it must be complete and must not drift from the spec.
 *
 * Note: §4.2's own closing text says "25 codes" but the table itself lists
 * 26 rows. This module follows the table (the actual specification), not
 * the prose count — the table is what step 59's contract test and the
 * client both depend on.
 *
 * `message` is the default, NFR-4.3-compliant user-facing text ("what to
 * do next", not only what failed). A call site MAY supply a more specific
 * message via AppError's constructor (e.g. DOCUMENT_TOO_LONG with the
 * document's actual word count, per the §4 example) — this default is
 * what's used when it doesn't.
 *
 * `retryAfter` (seconds) is set only on 503 entries, per §4.2's closing
 * note that every 503 carries a Retry-After header. A call site may
 * override it via AppError's `retryAfter` option when it knows a more
 * precise value (e.g. the circuit breaker's actual remaining open time).
 */
export const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: Object.freeze({
    status: 400,
    message: "Some of the information you sent couldn't be processed. Check your request and try again.",
  }),
  UNAUTHENTICATED: Object.freeze({
    status: 401,
    message: "You need to be signed in to do that. Please log in.",
  }),
  INVALID_CREDENTIALS: Object.freeze({
    status: 401,
    // Deliberately identical for "no such account" and "wrong password"
    // (§4.2) — a message that distinguishes the two confirms which
    // emails are registered.
    message: "The email or password you entered is incorrect. Check your details and try again.",
  }),
  SESSION_REVOKED: Object.freeze({
    status: 401,
    message: "Your session is no longer valid — this can happen after a password change or signing out everywhere. Please log in again.",
  }),
  EMAIL_NOT_VERIFIED: Object.freeze({
    status: 403,
    message: "Please verify your email address before running an analysis. Check your inbox for the verification link.",
  }),
  ACCOUNT_SUSPENDED: Object.freeze({
    status: 403,
    message: "Your account has been suspended. Contact support if you believe this is a mistake.",
  }),
  NOT_FOUND: Object.freeze({
    status: 404,
    message: "We couldn't find that. It may have been deleted, or it doesn't belong to your account.",
  }),
  EMAIL_TAKEN: Object.freeze({
    status: 409,
    message: "An account with that email already exists. Try logging in, or reset your password if you've forgotten it.",
  }),
  ANALYSIS_IN_PROGRESS: Object.freeze({
    status: 409,
    message: "An analysis for this document is already running. Wait for it to finish before starting another.",
  }),
  FILE_TOO_LARGE: Object.freeze({
    status: 413,
    message: "That file is over the 5 MB limit. Try a smaller file, or paste the text directly.",
  }),
  UNSUPPORTED_FILE_TYPE: Object.freeze({
    status: 422,
    message: "That file isn't a supported format. Upload a PDF or DOCX file, or paste the text directly.",
  }),
  MALFORMED_DOCUMENT: Object.freeze({
    status: 422,
    message: "We couldn't read that document. Make sure the file isn't corrupted, then try again.",
  }),
  ENCRYPTED_DOCUMENT: Object.freeze({
    status: 422,
    // FR-2.10: "a message asking for an unlocked copy."
    message: "This PDF is password-protected. Please upload an unlocked copy.",
  }),
  DOCUMENT_TOO_SHORT: Object.freeze({
    status: 422,
    message: "This document is too short to analyze — it may be a scanned image with no selectable text. Try a version with real text, or paste the text directly.",
  }),
  DOCUMENT_TOO_LONG: Object.freeze({
    status: 422,
    // §4's own example: "Document is 6,200 words. Phase 1 supports up to
    // 4,000." — the call site in the intake service (step 16) should pass
    // the actual word count as an explicit message following that
    // template. This is the fallback when it doesn't.
    message: "This document is too long for Phase 1's 4,000-word limit. Try a shorter document, or split it into sections.",
  }),
  STORAGE_QUOTA_EXCEEDED: Object.freeze({
    status: 422,
    // FR-2.13: "a message pointing at deletion."
    message: "You've reached your storage limit (100 documents or 50 MB). Delete an old document to make room for new ones.",
  }),
  RATE_LIMITED: Object.freeze({
    status: 429,
    message: "You've made too many requests. Please wait a moment and try again.",
  }),
  QUOTA_EXCEEDED: Object.freeze({
    status: 429,
    message: "You've reached your monthly analysis limit. It resets at the start of next month.",
  }),
  ACCOUNT_LOCKED: Object.freeze({
    status: 429,
    // FR-1.10: 15-minute lockout window.
    message: "Too many failed login attempts. Try again in 15 minutes.",
  }),
  INTERNAL: Object.freeze({
    status: 500,
    message: "Something went wrong on our end. Please try again, and contact support with the request ID below if it keeps happening.",
  }),
  LLM_INVALID_OUTPUT: Object.freeze({
    status: 502,
    // Verbatim from the §4.3 example.
    message: "The analysis service returned an unusable response twice. Your document was not affected — try again in a minute.",
  }),
  ALL_FINDINGS_DISCARDED: Object.freeze({
    status: 502,
    message: "The analysis service returned results that couldn't be verified against your document. Your document was not affected — try again in a minute.",
  }),
  LLM_UNAVAILABLE: Object.freeze({
    status: 503,
    // Verbatim from the §4.3 example, which also shows Retry-After: 60.
    message: "The analysis service is temporarily unavailable. Your document is saved — try again in about a minute.",
    retryAfter: 60,
  }),
  SPEND_LIMIT_REACHED: Object.freeze({
    status: 503,
    message: "Analysis is temporarily unavailable while we're above our monthly usage limit. Please try again later.",
    retryAfter: 3600,
  }),
  SERVER_BUSY: Object.freeze({
    status: 503,
    message: "The server is at capacity right now. Please try again in a few seconds.",
    retryAfter: 5,
  }),
  LLM_TIMEOUT: Object.freeze({
    status: 504,
    message: "The analysis service took too long to respond. Your document was not affected — try again in a minute.",
  }),
});

/** Fallback Retry-After (seconds) for a 503 whose code carries none. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * Looks up an error code's table entry. Returns undefined for an unknown
 * code — callers that require a match (AppError's constructor) should
 * throw rather than silently falling back, since an unknown code at that
 * point is a programming error, not a runtime condition.
 */
export function lookupErrorCode(code) {
  return ERROR_CODES[code];
}
