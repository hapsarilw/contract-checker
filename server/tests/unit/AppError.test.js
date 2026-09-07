import { describe, it, expect } from "vitest";
import { AppError } from "../../src/lib/AppError.js";
import { ERROR_CODES } from "../../src/lib/errorCodes.js";

describe("AppError (SRS §4.2)", () => {
  it("derives status and message from the error-code table", () => {
    const err = new AppError("NOT_FOUND");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.message).toBe(ERROR_CODES.NOT_FOUND.message);
    expect(err).toBeInstanceOf(Error);
  });

  it("throws immediately when constructed with an unknown code", () => {
    // Deliberately an invalid code — cast past the literal-union type to
    // exercise the runtime guard a caller's typo would actually hit.
    const bogusCode = /** @type {keyof typeof ERROR_CODES} */ ("NOT_A_REAL_CODE");
    expect(() => new AppError(bogusCode)).toThrow(/unknown error code/i);
  });

  it("status can never be overridden from the constructor — only the table decides it", () => {
    // @ts-expect-error — deliberately passing an option AppError's type doesn't declare
    const err = new AppError("NOT_FOUND", { status: 418 });
    expect(err.status).toBe(404);
  });

  it("accepts a specific message that overrides the table default", () => {
    const err = new AppError("DOCUMENT_TOO_LONG", {
      message: "Document is 6,200 words. Phase 1 supports up to 4,000.",
    });
    expect(err.message).toBe("Document is 6,200 words. Phase 1 supports up to 4,000.");
    expect(err.status).toBe(422);
  });

  it("carries details for server-side use, distinct from the message", () => {
    const details = { zodIssues: [{ path: ["email"], message: "Invalid email" }] };
    const err = new AppError("VALIDATION_ERROR", { details });
    expect(err.details).toBe(details);
  });

  it("uses the table's retryAfter by default and allows an explicit override", () => {
    const usingDefault = new AppError("LLM_UNAVAILABLE");
    expect(usingDefault.retryAfter).toBe(ERROR_CODES.LLM_UNAVAILABLE.retryAfter);

    const overridden = new AppError("LLM_UNAVAILABLE", { retryAfter: 12 });
    expect(overridden.retryAfter).toBe(12);
  });

  it("has a captured stack trace pointing above the constructor", () => {
    const err = new AppError("INTERNAL");
    expect(err.stack).toBeTypeOf("string");
    expect(err.stack).not.toContain("at new AppError");
  });
});
