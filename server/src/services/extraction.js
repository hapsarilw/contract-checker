import { createHash } from "node:crypto";

/**
 * FR-2.4 / FR-2.5 / FR-2.8 — pure functions, no I/O, no imports beyond
 * node:crypto. FR-2.4 requires exactly this, "because §5.3's correctness
 * depends entirely on it": a normalizer that reaches for a database or a
 * clock cannot be reasoned about, and this one is load-bearing for the
 * product's central safety claim.
 *
 * ─────────────────────────────────────────────────────────────────────
 * TWO NORMALIZERS EXIST. CONFUSING THEM BREAKS EXCERPT VERIFICATION.
 * ─────────────────────────────────────────────────────────────────────
 *
 * normalize() — this file, FR-2.4. Produces the text that is STORED as
 *   Document.rawText, hashed into textSha256, and sent to the model.
 *   It PRESERVES case and paragraph breaks, because the user will read
 *   findings quoted from it and the model needs readable structure.
 *
 * normalizeForMatch() — §5.3, step 20, its own module. Used ONLY to
 *   compare an excerpt against the document. It LOWERCASES and flattens
 *   every run of whitespace, newlines included, to single spaces. Its
 *   output is never stored and never shown to anyone.
 *
 * Using normalize() where normalizeForMatch() belongs makes verification
 * case- and layout-sensitive, so legitimate findings get discarded.
 * Using normalizeForMatch() where normalize() belongs destroys the
 * paragraph structure of every stored document. The quote and dash
 * folding below deliberately uses the SAME character set as §5.3's, so
 * the two agree about what a quote is even though they disagree about
 * everything else.
 */

/**
 * Zero-width characters: invisible in the interface, and therefore a way
 * to disguise injected instructions inside a contract (NFR-2.8 clause 4).
 * A model reads them; a user proof-reading the document cannot.
 */
const ZERO_WIDTH = new RegExp(
  [
    "\\u200B", // zero-width space
    "\\u200C", // zero-width non-joiner
    "\\u200D", // zero-width joiner
    "\\u2060", // word joiner
    "\\uFEFF", // zero-width no-break space / BOM
    "\\u180E", // Mongolian vowel separator
  ].join("|"),
  "g",
);

/**
 * Bidirectional overrides and isolates — the "Trojan Source" family.
 * They let rendered text differ from the underlying character order, so
 * a clause can display as harmless while carrying something else.
 */
const BIDI_CONTROLS = new RegExp(
  [
    "\\u200E", // left-to-right mark
    "\\u200F", // right-to-left mark
    "[\\u202A-\\u202E]", // embeddings, pop, and the two overrides
    "[\\u2066-\\u2069]", // isolates and pop
  ].join("|"),
  "g",
);

/**
 * Every C0 and C1 control character and DEL, with exactly two
 * exemptions: \t (U+0009) and \n (U+000A), which carry real structure.
 *
 * \r (U+000D) is deliberately NOT exempt. It is a control character, and
 * the only reason a document keeps its line breaks is that normalize()
 * converts \r to \n BEFORE this class is applied. Exempting \r here
 * would make that ordering decorative — the steps could be swapped with
 * no observable difference, and the requirement's "in this order" would
 * stop meaning anything.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is this line's whole job
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Exactly §5.3's set, so both normalizers agree on what folds to what. */
const CURLY_SINGLE_QUOTES = /[\u2018\u2019]/g;
const CURLY_DOUBLE_QUOTES = /[\u201C\u201D]/g;
const EN_EM_DASHES = /[\u2013\u2014]/g;

/**
 * FR-2.4's three steps, in the order the requirement gives them. The
 * order is load-bearing, and two pairs of steps demonstrably disagree if
 * swapped — both are covered by tests:
 *
 *   Line endings BEFORE control stripping. \r is itself a control
 *   character: strip first and a lone \r (a classic-Mac line ending)
 *   vanishes, silently joining two lines into one. Convert first and it
 *   becomes the paragraph break it was.
 *
 *   Invisible characters BEFORE whitespace collapsing. In "a <U+200B> b"
 *   the zero-width space sits between two real spaces. Strip it first
 *   and the spaces become adjacent, collapsing to one. Collapse first
 *   and each space is already alone, so stripping later leaves two —
 *   a difference that survives into the stored text and the hash.
 *
 * Not in FR-2.4, and therefore not done here: trimming the whole string.
 * A document with leading blank lines keeps them (collapsed to at most
 * two). Adding a trim would be a fourth step, and a silent fourth step
 * is how a spec and its implementation drift apart.
 */
export function normalize(text) {
  if (typeof text !== "string") {
    throw new TypeError("normalize() expects a string");
  }

  // Step 1 — line endings, then control characters, then invisibles.
  let result = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(ZERO_WIDTH, "")
    .replace(BIDI_CONTROLS, "");

  // Step 2 — quote and dash folding. Models routinely rewrite these when
  // quoting, so folding here is what keeps excerpt verification honest
  // rather than a punctuation lottery.
  result = result
    .replace(CURLY_SINGLE_QUOTES, "'")
    .replace(CURLY_DOUBLE_QUOTES, '"')
    .replace(EN_EM_DASHES, "-");

  // Step 3 — collapse horizontal whitespace, then vertical. Three or
  // more newlines become two: paragraph breaks survive, accidental
  // gutters do not.
  result = result.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");

  return result;
}

/**
 * FR-2.5 — whitespace-separated tokens AFTER normalisation.
 *
 * Normalises internally rather than trusting the caller to have done it.
 * A count taken from un-normalised text drifts from the stored document
 * (a zero-width space would split one word into two), and the failure is
 * silent: the number is merely wrong, never obviously wrong. normalize()
 * is idempotent, so passing already-normalised text costs a no-op pass
 * and changes nothing.
 */
export function countWords(text) {
  const normalized = normalize(text).trim();
  if (normalized === "") return 0;
  return normalized.split(/\s+/).length;
}

/**
 * FR-2.8 — hex SHA-256 of the normalised text, stored as
 * Document.textSha256 to key the Phase 2 cache.
 *
 * Normalises internally for the same reason countWords does, and it
 * matters more here: a cache key computed from un-normalised text would
 * miss on two uploads of the same contract that differ only in line
 * endings or a stray BOM. That is a cache that silently does nothing,
 * which is worse than no cache at all because it looks like it works.
 */
export function hashText(text) {
  return createHash("sha256").update(normalize(text), "utf8").digest("hex");
}
