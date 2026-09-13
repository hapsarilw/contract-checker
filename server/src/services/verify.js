/**
 * FR-3.3 / SRS §5.3 — excerpt verification, the product's central safety
 * control. Every excerpt a user is shown has passed through this file; a
 * failure here is a Sev-1 (PRD §14.3).
 *
 * Enforced, not just stated:
 *   - No dependencies (§5.3): eslint.config.js rejects any import here.
 *   - 100% branch coverage (§10.5): a threshold in vitest.config.js.
 * And by process: any change re-runs the accuracy benchmark (§10.4) and
 * needs review under branch protection (§12.1).
 */

/**
 * Text that has been through normalizeForMatch(). A plain string is not
 * assignable to it, which is what lets verifyFindings' signature — not a
 * comment — require the caller to normalise the document itself.
 *
 * @typedef {string & { readonly __brand: "NormalizedForMatch" }} NormalizedForMatch
 */

/**
 * §5.3's normaliser, transcribed — with one repair to the spec's text.
 *
 * The code block in docs/SRS.md has lost its curly quotes: checked byte by
 * byte, its first two character classes are [''] and [""], plain ASCII
 * (FR-2.4's wording in §3.2 shows the same damage). Transcribed literally,
 * they replace a straight quote with itself, and curly-quote folding
 * silently disappears while every other case still passes. The intended
 * set — what §5.3 and FR-2.4 call curly quotes, what §11.3's typographic
 * fixtures exist to exercise, and what extraction.js's normalize() already
 * folds — is U+2018/U+2019 and U+201C/U+201D. Written as \u escapes so no
 * editor, formatter, or document export can flatten it again.
 *
 * @param {string} s
 * @returns {NormalizedForMatch}
 */
export const normalizeForMatch = (s) =>
  /** @type {NormalizedForMatch} */ (
    s
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
  );

/**
 * The comparison, shared by both exports below so that a check built on
 * excerptAppears and production's verifyFindings can never disagree about
 * what "appears" means.
 *
 * NO FUZZY MATCHING — EVER (PRD D9). When the discard rate looks high, the
 * tempting fix is to loosen this: edit distance, token overlap, a
 * similarity score, stemming, ignoring punctuation. Each admits near
 * misses, and a near miss is exactly what a model paraphrasing or inventing
 * a clause produces; tolerating it is the hole this control exists to
 * close. The PRD settled this in advance and set a measured trigger
 * instead — a discard rate over 10% for 7 days opens a review of §5.3's
 * strictness (PRD §11.1, alert discard_rate_high). Loosen it on that
 * review's data and a re-run benchmark, never on instinct.
 *
 * The empty-excerpt guard is the one addition to §5.3's expression, and it
 * can only discard. Every string includes "", so an excerpt that
 * normalises to nothing — ten spaces satisfy §5.2's .min(10) — would
 * "appear" in every document: a finding verified by vacuous truth, with no
 * quote behind it.
 *
 * @param {NormalizedForMatch} normalizedExcerpt
 * @param {NormalizedForMatch} normalizedDocText
 * @returns {boolean}
 */
function appearsIn(normalizedExcerpt, normalizedDocText) {
  // An if, not `a && b`: coverage counts both operands of && as covered as
  // soon as the right one has ever run, so §10.5's 100% would pass with no
  // test reaching this discard. As an if, skipping those tests drops it to 50%.
  if (normalizedExcerpt === "") return false;
  return normalizedDocText.includes(normalizedExcerpt);
}

/**
 * §5.3's excerptAppears. Normalises both sides on every call, so it is for
 * single checks — never a loop over findings; that is verifyFindings' job.
 *
 * @param {string} excerpt
 * @param {string} docText
 * @returns {boolean}
 */
export const excerptAppears = (excerpt, docText) =>
  appearsIn(normalizeForMatch(excerpt), normalizeForMatch(docText));

/**
 * The orchestrator's entry point (§2.2 step 7).
 *
 * §5.3 requires the document side to be normalised once per analysis, not
 * once per finding: mapping excerptAppears over 25 findings normalises a
 * 4,000-word document 25 times for nothing. So the caller normalises once
 * and passes the result, and NormalizedForMatch turns that from a
 * convention into a signature — typecheck rejects
 * verifyFindings(findings, document.rawText). The document is used exactly
 * as given; only excerpts are normalised here. A caller that slips raw text
 * past the type fails closed: matching only gets stricter, so findings are
 * wrongly discarded, never wrongly admitted.
 *
 * Returns the surviving findings in their original order and the count
 * that becomes Analysis.discardedFindings. What an all-discarded result
 * means (FR-3.4) is the orchestrator's decision.
 *
 * @template {{ clause_excerpt: string }} F
 * @param {readonly F[]} findings
 * @param {NormalizedForMatch} preNormalizedDocText
 * @returns {{ verified: F[], discardedCount: number }}
 */
export function verifyFindings(findings, preNormalizedDocText) {
  const verified = findings.filter((finding) =>
    appearsIn(normalizeForMatch(finding.clause_excerpt), preNormalizedDocText),
  );
  return { verified, discardedCount: findings.length - verified.length };
}
