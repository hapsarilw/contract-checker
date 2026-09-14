import "./SeverityBadge.css";

/**
 * BUILD-PLAN step 30 — FR-3.9's three severity levels, ported from the
 * prototype's SEV map (docs/design/ClauseCheck.html): a filled/hollow
 * dot mark per level (●●● / ●●○ / ●○○) alongside the tint/strong colour
 * pair it already used, reused here as this component's tinted
 * background and text/border colour.
 *
 * WCAG 1.4.1 (SRS §7.15's "Severity encoding" row): text label plus a
 * shape, never colour alone. The dot count IS that shape — three
 * different counts of filled dots are still distinguishable with color
 * vision deficiency or on a grayscale printout, which colour alone is
 * not. The dot mark is `aria-hidden`: it is a second channel for the
 * same information the text label already gives, and a screen reader
 * spelling out "black circle black circle black circle" after "High"
 * adds noise, not information.
 *
 * Contrast (checked at build time, step 30 — see tokens.css's severity
 * tint comment): text-on-tint clears 4.5:1 for all three combinations,
 * medium is the tightest at 4.92:1.
 *
 * `label` is a prop, not looked up here, so this component stays
 * decoupled from the i18n system (BUILD-PLAN decision D-B) — the caller
 * passes the string translations.
 *
 * `variant="inline"` is the finding card's treatment (step 36): label
 * first, mark after, no tint or accent border — the same text-plus-shape
 * encoding, laid out the way the prototype's card header lays it out.
 *
 * @param {{
 *   severity: "high" | "medium" | "low",
 *   label: string,
 *   variant?: "badge" | "inline",
 *   className?: string,
 * }} props
 */
export default function SeverityBadge({
  severity,
  label,
  variant = "badge",
  className = "",
}) {
  const mark = (
    <span className="cc-severity-badge__mark" aria-hidden="true">
      {MARKS[severity]}
    </span>
  );
  const classes = [
    "cc-severity-badge",
    `cc-severity-badge--${severity}`,
    variant === "inline" ? "cc-severity-badge--inline" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes}>
      {variant === "inline" ? (
        <>
          {label}
          {mark}
        </>
      ) : (
        <>
          {mark}
          {label}
        </>
      )}
    </span>
  );
}

const MARKS = {
  high: "●●●",
  medium: "●●○",
  low: "●○○",
};

/**
 * Exported so other severity-aware displays that aren't this badge shape
 * — the report's risk header and severity breakdown bars (BUILD-PLAN
 * step 35) — can use the same three glyphs instead of redeclaring them.
 */
export const SEVERITY_MARKS = MARKS;
