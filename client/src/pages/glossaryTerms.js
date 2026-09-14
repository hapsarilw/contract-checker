/**
 * BUILD-PLAN step 36 / decision D-C — which words in a finding's
 * explanation get a glossary popover.
 *
 * The prototype marks terms inline in its hand-written demo copy
 * (`[[indemnity|indemnity]]`, docs/design/ClauseCheck.html's parseParts).
 * Real explanations are model output, and the analyze prompt
 * (server/src/prompts/analyze.js) asks for no such markup — so porting
 * the parser would show no glossary at all in production, and asking
 * the model for markup would change the output contract and the prompt,
 * which D-C only approves the glossary on condition of NOT doing.
 * Instead: a fixed list of patterns, matched client-side. The model can
 * neither add a term nor influence a definition; it can only happen to
 * use a word this list already knows.
 *
 * Keys match the prototype's GLOSS map (and strings/en.js's `glossary`).
 * Each term is glossed at its first occurrence per explanation only, as
 * in the prototype's copy — a paragraph with the same dotted underline
 * three times reads as noise, not help.
 */
export const GLOSSARY_PATTERNS = Object.freeze(
  /** @type {ReadonlyArray<readonly [string, RegExp]>} */ ([
    ["assignment", /\bassignment\b/i],
    ["indemnity", /\bindemnit(?:y|ies)\b/i],
    ["noncompete", /\bnon-?competes?\b/i],
    ["killfee", /\bkill fees?\b/i],
    ["net90", /\bnet[- ]?90\b/i],
    ["net60", /\bnet[- ]?60\b/i],
    ["acceptance", /\bacceptance\b/i],
    ["liabilitycap", /\b(?:liability caps?|limitation of liability)\b/i],
  ]),
);

/**
 * @typedef {{ type: "text", text: string } | { type: "term", key: string, text: string }} GlossarySegment
 */

/**
 * Splits `text` into plain-text and glossary-term segments. Pure data:
 * the caller renders every segment's `text` as a React text node, so
 * nothing in `text` is ever interpreted as markup (FR-7.8).
 *
 * @param {string} text
 * @returns {GlossarySegment[]}
 */
export function splitGlossaryTerms(text) {
  /** @type {GlossarySegment[]} */
  const segments = [];
  const used = new Set();
  let rest = text;

  for (;;) {
    /** @type {{ key: string, index: number, text: string } | null} */
    let earliest = null;
    for (const [key, pattern] of GLOSSARY_PATTERNS) {
      if (used.has(key)) continue;
      const match = pattern.exec(rest);
      if (match && (earliest === null || match.index < earliest.index)) {
        earliest = { key, index: match.index, text: match[0] };
      }
    }
    if (earliest === null) break;

    if (earliest.index > 0)
      segments.push({ type: "text", text: rest.slice(0, earliest.index) });
    segments.push({ type: "term", key: earliest.key, text: earliest.text });
    used.add(earliest.key);
    rest = rest.slice(earliest.index + earliest.text.length);
  }

  if (rest !== "") segments.push({ type: "text", text: rest });
  return segments;
}
