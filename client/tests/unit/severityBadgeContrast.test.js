import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * BUILD-PLAN step 30 — "Badge text must clear 4.5:1 contrast against the
 * badge background... severity badges are the usual place a design
 * fails this, so check the three combinations explicitly." This is that
 * check, as a test rather than a one-off calculation: it fails loudly if
 * tokens.css's severity colours or tints ever drift.
 *
 * Reads tokens.css directly rather than hardcoding its hex values here —
 * an earlier version of this file did the latter with a comment claiming
 * SeverityBadge.test.jsx would catch drift "differently," by checking a
 * rendered badge's computed style against the same hardcoded values.
 * That claim was never true: jsdom does not resolve CSS custom
 * properties in getComputedStyle, so that check was later removed, and a
 * tokens.css edit could drift silently out from under this file's copy
 * with nothing catching it (confirmed with a real mutation: darkening
 * --cc-severity-medium-tint in tokens.css did not fail this suite until
 * this file was rewritten to read the real source). Regex-extracting a
 * CSS custom property is simple enough not to need a parser dependency,
 * and it closes that gap for good — there is no longer a second copy of
 * these values to drift.
 *
 * The WCAG contrast formula, not a library: this file already has one
 * other job and the formula is a dozen lines, all from the spec itself
 * (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance /
 * #dfn-contrast-ratio) — a dependency would be more code to trust, not
 * less.
 */

const TOKENS_CSS_PATH = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  "src/styles/tokens.css",
);

/**
 * @param {string} css
 * @param {string} name e.g. "--cc-severity-high"
 * @returns {string} the value, normalised to uppercase "#RRGGBB"
 */
function readColorToken(css, name) {
  const pattern = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`);
  const match = css.match(pattern);
  if (!match) {
    throw new Error(
      `tokens.css has no ${name} declaration (or it isn't a #RRGGBB colour)`,
    );
  }
  return match[1].toUpperCase();
}

/** @param {number} c 0-255 */
function srgbToLinear(c) {
  const normalized = c / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

/** @param {string} hex e.g. "#7A3F2E" */
function relativeLuminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const [R, G, B] = [r, g, b].map(srgbToLinear);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** @param {string} a @param {string} b */
function contrastRatio(a, b) {
  const L1 = relativeLuminance(a);
  const L2 = relativeLuminance(b);
  const [lighter, darker] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (lighter + 0.05) / (darker + 0.05);
}

const tokensCss = readFileSync(TOKENS_CSS_PATH, "utf8");
const SEVERITY_COMBOS = Object.fromEntries(
  ["high", "medium", "low"].map((severity) => [
    severity,
    {
      text: readColorToken(tokensCss, `--cc-severity-${severity}`),
      tint: readColorToken(tokensCss, `--cc-severity-${severity}-tint`),
    },
  ]),
);

const AA_NORMAL_TEXT_MINIMUM = 4.5;

describe("SeverityBadge text/background contrast (SRS §7.15, WCAG 1.4.1)", () => {
  it.each(Object.entries(SEVERITY_COMBOS))(
    "%s: text on tint clears %s:1",
    (severity, { text, tint }) => {
      const ratio = contrastRatio(text, tint);
      expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MINIMUM);
    },
  );

  it("medium is the tightest margin, and it still clears the minimum", () => {
    // A specific regression target, not just "all three pass": if a
    // future palette change shaves even a little off medium's contrast,
    // this fails before the aggregate check above needs to.
    const ratio = contrastRatio(SEVERITY_COMBOS.medium.text, SEVERITY_COMBOS.medium.tint);
    expect(ratio).toBeGreaterThanOrEqual(4.9);
    expect(ratio).toBeLessThan(5.0);
  });
});
