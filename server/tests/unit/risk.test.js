import { describe, it, expect } from "vitest";
import { deriveOverallRisk } from "../../src/services/risk.js";

/**
 * TR-6 (SRS §10.1) — risk derivation (FR-3.9, PRD §7).
 *
 * Section 10.5 requires 100% branch coverage here too. As with verify.js,
 * treat that as nearly free — the function is two `.some()` checks — and
 * TR-6's own cases, plus the D7 and "missing protections" cases below, as
 * the real gate.
 */

/** @type {{ severity: "high" }} */
const high = { severity: "high" };
/** @type {{ severity: "medium" }} */
const medium = { severity: "medium" };
/** @type {{ severity: "low" }} */
const low = { severity: "low" };

describe("TR-6 — risk derivation (FR-3.9)", () => {
  it("high plus low findings yields HIGH", () => {
    expect(deriveOverallRisk([high, low])).toBe("HIGH");
  });

  it("mediums only yields MEDIUM", () => {
    expect(deriveOverallRisk([medium, medium])).toBe("MEDIUM");
  });

  it("an empty array yields LOW", () => {
    expect(deriveOverallRisk([])).toBe("LOW");
  });

  it("missing protections are present but findings are empty — still LOW", () => {
    // Shaped like §5.2's AnalysisResult, to make the point concrete rather
    // than assert it against an empty array in the abstract: a document
    // that is missing every standard protection but has no risky findings
    // is still LOW. The signature only accepts .findings, so there is no
    // argument position through which missing_clauses COULD reach this
    // function even if a caller wanted it to.
    const modelResult = {
      overall_risk: "low",
      findings: [],
      missing_clauses: [
        "No late payment interest or penalty is specified.",
        "No limitation of liability clause is present.",
        "No kill fee is specified.",
      ],
    };
    expect(deriveOverallRisk(modelResult.findings)).toBe("LOW");
  });
});

describe("every branch: a high, a medium-not-high, and neither present", () => {
  it("a lone high finding yields HIGH", () => {
    expect(deriveOverallRisk([high])).toBe("HIGH");
  });

  it("a lone medium finding yields MEDIUM", () => {
    expect(deriveOverallRisk([medium])).toBe("MEDIUM");
  });

  it("low findings only yields LOW — the zero-findings case is not the only way to reach LOW", () => {
    expect(deriveOverallRisk([low, low])).toBe("LOW");
  });

  it("high wins over medium regardless of position or count", () => {
    expect(deriveOverallRisk([medium, medium, high, medium])).toBe("HIGH");
    expect(deriveOverallRisk([high, medium])).toBe("HIGH");
  });
});

describe("the model's own claim never influences the result (PRD D7)", () => {
  it("a model that claims low risk does not suppress a HIGH the findings themselves justify", () => {
    // This is D7's rationale made concrete: the rule and the model are
    // allowed to disagree — that disagreement is the drift signal §11.1
    // measures — and the rule is what a user sees regardless.
    const modelResult = { overall_risk: "low", findings: [high], missing_clauses: [] };
    expect(deriveOverallRisk(modelResult.findings)).toBe("HIGH");
  });

  it("the function's signature has no parameter a caller could pass modelRisk through", () => {
    // @ts-expect-error — deriveOverallRisk takes exactly one argument;
    // this is a type error, not merely an unused value. If a second
    // parameter is ever added, this line stops being an error and
    // `npm run typecheck` fails on the unused directive.
    deriveOverallRisk([], "HIGH");
  });
});
