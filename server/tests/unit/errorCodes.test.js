import { describe, it, expect } from "vitest";
import { ERROR_CODES, lookupErrorCode, DEFAULT_RETRY_AFTER_SECONDS } from "../../src/lib/errorCodes.js";

// The literal SRS §4.2 table, transcribed independently of errorCodes.js,
// so this test catches the module drifting from the spec rather than just
// re-checking itself. (§4.2's own prose says "25 codes" but the table has
// 26 rows — errorCodes.js follows the table, which is what step 59's
// OpenAPI contract test and the client both depend on.)
const SPEC_TABLE = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  SESSION_REVOKED: 401,
  EMAIL_NOT_VERIFIED: 403,
  ACCOUNT_SUSPENDED: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  ANALYSIS_IN_PROGRESS: 409,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 422,
  MALFORMED_DOCUMENT: 422,
  ENCRYPTED_DOCUMENT: 422,
  DOCUMENT_TOO_SHORT: 422,
  DOCUMENT_TOO_LONG: 422,
  STORAGE_QUOTA_EXCEEDED: 422,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  ACCOUNT_LOCKED: 429,
  INTERNAL: 500,
  LLM_INVALID_OUTPUT: 502,
  ALL_FINDINGS_DISCARDED: 502,
  LLM_UNAVAILABLE: 503,
  SPEND_LIMIT_REACHED: 503,
  SERVER_BUSY: 503,
  LLM_TIMEOUT: 504,
};

describe("errorCodes.js (SRS §4.2)", () => {
  it("has exactly the 26 codes the spec table lists, no more, no fewer", () => {
    expect(Object.keys(ERROR_CODES).sort()).toEqual(Object.keys(SPEC_TABLE).sort());
  });

  it.each(Object.entries(SPEC_TABLE))("%s maps to status %i", (code, expectedStatus) => {
    expect(ERROR_CODES[code].status).toBe(expectedStatus);
  });

  it("every entry has a non-empty message", () => {
    for (const [code, entry] of Object.entries(ERROR_CODES)) {
      expect(entry.message, `${code} has an empty message`).toBeTypeOf("string");
      expect(entry.message.length, `${code} has an empty message`).toBeGreaterThan(0);
    }
  });

  it("every 503 carries a retryAfter, and no other status does", () => {
    for (const [code, rawEntry] of Object.entries(ERROR_CODES)) {
      const entry = /** @type {{ status: number, retryAfter?: number }} */ (rawEntry);
      if (entry.status === 503) {
        expect(entry.retryAfter, `${code} is 503 but has no retryAfter`).toBeTypeOf("number");
      } else {
        expect(entry.retryAfter, `${code} is not 503 but has a retryAfter`).toBeUndefined();
      }
    }
  });

  it("uses the exact verbatim message from the §4.3 example for LLM_INVALID_OUTPUT", () => {
    expect(ERROR_CODES.LLM_INVALID_OUTPUT.message).toBe(
      "The analysis service returned an unusable response twice. Your document was not affected — try again in a minute.",
    );
  });

  it("uses the exact verbatim message and Retry-After from the §4.3 example for LLM_UNAVAILABLE", () => {
    expect(ERROR_CODES.LLM_UNAVAILABLE.message).toBe(
      "The analysis service is temporarily unavailable. Your document is saved — try again in about a minute.",
    );
    expect(ERROR_CODES.LLM_UNAVAILABLE.retryAfter).toBe(60);
  });

  it("lookupErrorCode returns undefined for an unknown code", () => {
    expect(lookupErrorCode("NOT_A_REAL_CODE")).toBeUndefined();
  });

  it("DEFAULT_RETRY_AFTER_SECONDS is a positive number", () => {
    expect(DEFAULT_RETRY_AFTER_SECONDS).toBeGreaterThan(0);
  });
});
