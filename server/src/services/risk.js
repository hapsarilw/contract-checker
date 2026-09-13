/**
 * FR-3.9 / PRD §7 — server-side risk derivation.
 *
 * `overallRisk` is a deterministic function of the surviving findings'
 * severities, computed here rather than taken from the model, so the risk
 * a user sees can never disagree with the findings they're reading below
 * it. The model's own opinion is stored separately as `modelRisk` for
 * drift measurement and is never shown to the user (PRD D7) — this module
 * doesn't accept it as input, so it cannot influence the result even by
 * accident.
 *
 * Deliberately excluded from the rule, and so also not an input here:
 * missing protections (PRD §7's checklist). This is an accepted, documented
 * Phase 1 limitation, not an oversight — PRD §7 revisits it only once the
 * §11.1 rule/model drift metric has real data behind it. "Fixing" it early,
 * by folding missing protections into this function, would contradict that
 * decision silently.
 */

/**
 * @template {{ severity: "low" | "medium" | "high" }} F
 * @param {readonly F[]} findings — the findings that survived §5.3
 *   verification. Called with an empty array for a clean contract, which
 *   is a legitimate LOW, not a missing input.
 * @returns {"LOW" | "MEDIUM" | "HIGH"}
 */
export function deriveOverallRisk(findings) {
  if (findings.some((finding) => finding.severity === "high")) return "HIGH";
  if (findings.some((finding) => finding.severity === "medium")) return "MEDIUM";
  return "LOW";
}
