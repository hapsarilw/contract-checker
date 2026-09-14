import { describe, expect, it } from "vitest";
import { sanitizeReturnTo } from "../../src/auth/returnTo.js";

/**
 * BUILD-PLAN step 32 — `returnTo` arrives in the URL, so it is
 * attacker-controlled input: this is the open-redirect guard, tested
 * with the actual attack shapes it exists to stop, not just the happy
 * path.
 */
describe("sanitizeReturnTo (open-redirect guard)", () => {
  it.each([
    ["/documents", "/documents"],
    ["/documents/abc123", "/documents/abc123"],
    ["/documents?foo=bar", "/documents?foo=bar"],
    ["/", "/"],
  ])("accepts a same-origin absolute path %s", (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected);
  });

  it.each([
    ["//evil.example", "protocol-relative — resolves to the current scheme, off-site"],
    ["https://evil.example", "a fully-qualified external URL"],
    ["http://evil.example/x", "a fully-qualified external URL, http"],
    ["javascript:alert(1)", "a javascript: URL — never a path at all"],
    ["documents", "no leading slash — not an absolute path"],
    ["", "empty string"],
    [" /documents", "leading whitespace defeats the startsWith('/') check"],
  ])("falls back to / for %s (%s)", (input) => {
    expect(sanitizeReturnTo(input)).toBe("/");
  });

  it.each([
    ["/\\evil.example", "one leading slash then a backslash"],
    ["/\\/evil.example", "slash, backslash, slash"],
  ])(
    "falls back to / for %s — a real bypass class: browsers normalise a leading backslash to a slash, so this becomes protocol-relative after the fact",
    (input) => {
      // This is exactly what the startsWith("/") / !startsWith("//")
      // fast path alone CANNOT catch: the string passes both those
      // checks (one leading char is "/", the second is "\", not "/") —
      // only the URL()-based round trip, which uses the same
      // normalisation a real browser applies before navigating, sees
      // that it resolves off-origin. Confirmed directly: `new URL("/\\
      // evil.example", "http://x")` resolves to `http://evil.example/`.
      expect(sanitizeReturnTo(input)).toBe("/");
    },
  );

  it.each([null, undefined, 42, {}, []])(
    "falls back to / for non-string input %j",
    (input) => {
      // @ts-expect-error — deliberately passing the wrong type, since a
      // real caller reads this from URLSearchParams.get(), which is
      // typed as returning string | null but is really "whatever a user
      // put in the URL."
      expect(sanitizeReturnTo(input)).toBe("/");
    },
  );

  it("preserves a query string and hash on an accepted path", () => {
    expect(sanitizeReturnTo("/documents/abc?tab=findings#f3")).toBe(
      "/documents/abc?tab=findings#f3",
    );
  });
});
