import { describe, it, expect } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, MAX_KEY_LENGTH, readIdempotencyKey } from "../../src/lib/idempotency.js";

/**
 * FR-3.15's header-reading rule, tested directly rather than only through
 * the integration route (tests/integration/idempotency.test.js).
 *
 * WHY THIS FILE EXISTS SEPARATELY. Both of readIdempotencyKey's callers
 * (documents.js's replayIdempotentRequest middleware, and the route
 * handler's `if (req.idempotencyKey)`) already treat an empty string as
 * falsy, so a request made through the real route cannot distinguish
 * "readIdempotencyKey correctly returns null for a blank header" from
 * "readIdempotencyKey returns '' and the caller's own truthiness check
 * happens to catch it" — both produce the same HTTP behaviour. Only a
 * direct call proves which one is actually happening, and mutation
 * testing this file against the route-level tests confirmed it: deleting
 * the blank-string check in readIdempotencyKey left every integration
 * test green.
 */

const req = (value) => ({ headers: value === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: value } });

describe("readIdempotencyKey (FR-3.15)", () => {
  it("returns null when the header is absent", () => {
    expect(readIdempotencyKey(req())).toBeNull();
  });

  it("returns null for a blank header value", () => {
    expect(readIdempotencyKey(req(""))).toBeNull();
  });

  it("returns null for a whitespace-only header value", () => {
    expect(readIdempotencyKey(req("   "))).toBeNull();
  });

  it("returns the trimmed value for an ordinary key", () => {
    expect(readIdempotencyKey(req("  retry-2026-09-23  "))).toBe("retry-2026-09-23");
  });

  it("accepts a key at exactly the length bound", () => {
    const atBound = "k".repeat(MAX_KEY_LENGTH);
    expect(readIdempotencyKey(req(atBound))).toBe(atBound);
  });

  it("returns null one character past the length bound, rather than truncating it into a different key", () => {
    // Truncating would be worse than rejecting: two different oversized
    // keys that share the same first MAX_KEY_LENGTH characters would
    // collide on the same Redis key and replay each other's documents.
    const overBound = "k".repeat(MAX_KEY_LENGTH + 1);
    expect(readIdempotencyKey(req(overBound))).toBeNull();
  });

  it("returns null for a non-string header value", () => {
    // Express normalises repeated headers into one comma-joined string
    // for everything except Set-Cookie, so req.headers[...] should never
    // actually be an array here — this is defense against that
    // assumption being wrong, not a documented Express behaviour.
    expect(readIdempotencyKey(req(["a", "b"]))).toBeNull();
  });
});
