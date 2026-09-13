import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  resolvePageLimit,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "../../src/lib/pagination.js";

describe("encodeCursor / decodeCursor (§4.4)", () => {
  it("round-trips createdAt and id exactly", () => {
    const createdAt = new Date("2026-08-31T07:20:11.123Z");
    const cursor = encodeCursor({ createdAt, id: "cm0xabc123" });

    const decoded = decodeCursor(cursor);
    if (decoded === null) throw new Error("expected a valid cursor to decode");
    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(decoded.id).toBe("cm0xabc123");
  });

  it("produces the exact JSON shape the §4.4 example itself uses", () => {
    // §4.4's own example cursor "eyJjIjoiMjAy..." decodes to
    // {"c":"202...} — this proves the encoding matches that convention
    // byte-for-byte, not just "some opaque string that happens to work".
    const cursor = encodeCursor({ createdAt: new Date("2026-08-31T07:20:11.000Z"), id: "x" });
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    expect(JSON.parse(json)).toEqual({ c: "2026-08-31T07:20:11.000Z", i: "x" });
  });

  it("is a URL-safe string with no characters needing escaping in a query param", () => {
    const cursor = encodeCursor({ createdAt: new Date(), id: "cm0xabc123" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["not base64 at all", "!!! not valid base64 ???"],
    ["valid base64 of non-JSON text", Buffer.from("just some plain text", "utf8").toString("base64url")],
    ["valid JSON but the wrong shape entirely", Buffer.from(JSON.stringify([1, 2, 3]), "utf8").toString("base64url")],
    ["valid JSON object missing both fields", Buffer.from(JSON.stringify({}), "utf8").toString("base64url")],
    ["missing id", Buffer.from(JSON.stringify({ c: "2026-08-31T07:20:11.000Z" }), "utf8").toString("base64url")],
    ["missing createdAt", Buffer.from(JSON.stringify({ i: "abc" }), "utf8").toString("base64url")],
    ["createdAt is a number, not a string", Buffer.from(JSON.stringify({ c: 12345, i: "abc" }), "utf8").toString("base64url")],
    ["id is a number, not a string", Buffer.from(JSON.stringify({ c: "2026-08-31T07:20:11.000Z", i: 5 }), "utf8").toString("base64url")],
    ["id is an empty string", Buffer.from(JSON.stringify({ c: "2026-08-31T07:20:11.000Z", i: "" }), "utf8").toString("base64url")],
    ["createdAt is not a parseable date", Buffer.from(JSON.stringify({ c: "not-a-date", i: "abc" }), "utf8").toString("base64url")],
    ["createdAt is null", Buffer.from(JSON.stringify({ c: null, i: "abc" }), "utf8").toString("base64url")],
    ["the JSON is a bare string, not an object", Buffer.from(JSON.stringify("just a string"), "utf8").toString("base64url")],
    ["the JSON is null", Buffer.from("null", "utf8").toString("base64url")],
    ["empty string", ""],
    ["not a string at all", 12345],
    ["undefined", undefined],
    ["an array", ["a", "b"]],
    ["an object", { c: "x", i: "y" }],
  ])("returns null, never throws, for: %s", (_label, malformed) => {
    expect(() => decodeCursor(malformed)).not.toThrow();
    expect(decodeCursor(malformed)).toBeNull();
  });

  it("a single flipped character in an otherwise-valid cursor still decodes cleanly to null or a value — never throws", () => {
    // "Tampered" per §4.4's own wording — someone hand-edited a cursor
    // that used to be valid. This doesn't assert null specifically
    // (flipping one base64 character can, in principle, still decode to
    // some other valid-shaped JSON) — it asserts the one thing that
    // actually matters: it never throws.
    const valid = encodeCursor({ createdAt: new Date(), id: "cm0xabc123" });
    const tampered = valid.slice(0, -1) + (valid.at(-1) === "A" ? "B" : "A");
    expect(() => decodeCursor(tampered)).not.toThrow();
  });
});

describe("resolvePageLimit (§4.4)", () => {
  it("defaults to 20 when no limit is given", () => {
    expect(resolvePageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(DEFAULT_PAGE_LIMIT).toBe(20);
  });

  it("clamps 500 to 100 — the exact case the prompt names", () => {
    expect(resolvePageLimit("500")).toBe(100);
    expect(resolvePageLimit(500)).toBe(100);
    expect(MAX_PAGE_LIMIT).toBe(100);
  });

  it("passes through a valid limit unchanged", () => {
    expect(resolvePageLimit("50")).toBe(50);
    expect(resolvePageLimit(1)).toBe(1);
  });

  it("accepts the limit exactly at the maximum, unclamped", () => {
    expect(resolvePageLimit(100)).toBe(100);
  });

  it.each([
    ["zero", "0"],
    ["negative", "-5"],
    ["non-numeric", "banana"],
    ["fractional", "5.5"],
    ["empty string", ""],
    ["whitespace", "   "],
  ])("falls back to the default for %s", (_label, raw) => {
    expect(resolvePageLimit(raw)).toBe(DEFAULT_PAGE_LIMIT);
  });
});
