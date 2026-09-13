/**
 * §4.4 — cursor (keyset) pagination, never offset.
 *
 * Offset pagination ("skip N rows") is rejected by the spec because it
 * is defined relative to the CURRENT state of the table: if a document
 * is deleted between two page fetches, every row after it shifts up by
 * one, and "skip 20" now means a different set of rows than it did a
 * moment ago — the next page silently skips one row and, on the page
 * after a re-fetch, can duplicate another. Cursor pagination sidesteps
 * this entirely by defining "the next page" relative to a specific ROW
 * (createdAt, id) rather than a position in a list. Deleting an
 * unrelated row anywhere in the table changes nothing about what
 * "before this specific document" means.
 *
 * The cursor encodes `(createdAt, id)`, matching §4.4's own example
 * byte-for-byte — `"eyJjIjoiMjAy..."` decodes to `{"c":"202...`,
 * confirmed by decoding it, not guessed at. `id` breaks ties: two
 * documents can share a millisecond-precision createdAt (the column is
 * TIMESTAMP(3)), and without a tie-breaker two rows with the same
 * timestamp would be ambiguously ordered, letting one of them be
 * skipped or repeated across a page boundary.
 */

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/**
 * Opaque to the client on purpose — not cryptographically signed, just
 * not meant to be hand-edited. `decodeCursor` treats anything that
 * doesn't survive the round trip as absent rather than throwing, which
 * is what makes a tampered cursor a clean 400 instead of a stack trace.
 *
 * @param {{ createdAt: Date, id: string }} row
 * @returns {string}
 */
export function encodeCursor({ createdAt, id }) {
  const payload = JSON.stringify({ c: createdAt.toISOString(), i: id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Returns `{ createdAt, id }` for a well-formed cursor, or `null` for
 * ANYTHING else — wrong base64, non-JSON, the right JSON shape with
 * wrong types, an unparseable date. Every failure mode returns `null`
 * rather than throwing; the route turns a `null` into 400
 * VALIDATION_ERROR, so nothing here can become an unhandled 500.
 *
 * Deliberately never throws even on wildly malformed input:
 * `Buffer.from(x, "base64url")` doesn't throw on invalid base64 (Node
 * decodes leniently), so the real validation work is checking the
 * DECODED shape, not trusting that decoding succeeding means anything.
 *
 * @param {unknown} raw
 * @returns {{ createdAt: Date, id: string } | null}
 */
export function decodeCursor(raw) {
  if (typeof raw !== "string" || raw === "") return null;

  let json;
  try {
    json = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  if (typeof parsed.c !== "string" || typeof parsed.i !== "string" || parsed.i === "") return null;

  const createdAt = new Date(parsed.c);
  if (Number.isNaN(createdAt.getTime())) return null;

  return { createdAt, id: parsed.i };
}

/**
 * §4.4: "limit defaults to 20 and is clamped to 100." Clamped, not
 * rejected — an oversized or malformed limit is a client being
 * enthusiastic or sloppy, not a request worth a 400 over.
 *
 * Missing, non-numeric, zero, negative, or fractional all fall back to
 * the default rather than erroring — the spec names only the upper
 * bound as a clamp; treating every other kind of "not a sensible limit"
 * the same forgiving way is one rule instead of several special cases.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function resolvePageLimit(raw) {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(parsed, MAX_PAGE_LIMIT);
}
