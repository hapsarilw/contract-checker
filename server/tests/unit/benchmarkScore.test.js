import { describe, it, expect } from "vitest";
import {
  excerptsMatch,
  scoreRepeat,
  spread,
  evaluateGates,
  cleanDocuments,
  acceptedDocuments,
} from "../../../scripts/score.js";

/**
 * The benchmark's scoring half decides whether a release is blocked
 * (PRD §11.1), so it is tested rather than trusted. These are pure
 * functions over data — no provider, no database, no environment.
 *
 * The answer key below is a miniature of the real one's shape, not a copy
 * of it: a test that read the real corpus would change meaning every time
 * the corpus did.
 */
const key = {
  documents: [
    {
      file: "hostile",
      intake: "accept",
      overall_risk: "high",
      findings: [
        {
          severity: "high",
          category: "ip",
          excerpt: "shall become the sole property of Client",
          why: "pre-existing work",
        },
        {
          severity: "medium",
          category: "payment",
          excerpt: "within ninety (90) days",
          why: "net-90",
        },
      ],
      missing_protections: ["a kill fee"],
    },
    {
      file: "mixed",
      intake: "accept",
      overall_risk: "medium",
      findings: [
        {
          severity: "high",
          category: "scope",
          excerpt: "unlimited revisions",
          why: "no cap",
        },
      ],
      also_acceptable: [
        {
          severity: "low",
          category: "dispute",
          excerpt: "courts of Delaware",
          why: "forum",
        },
      ],
      fair_clauses_do_not_flag: [
        {
          excerpt: "Fifty percent (50%) is due upon execution",
          why: "deposit, favourable",
        },
        { excerpt: "two (2) rounds of revisions", why: "revision limit, favourable" },
      ],
      missing_protections: [],
    },
    {
      file: "clean",
      intake: "accept",
      overall_risk: "low",
      findings: [],
      missing_protections: [],
    },
    { file: "rejected", intake: "reject", expect_error: "DOCUMENT_TOO_SHORT" },
  ],
};

/** A perfect pass: every planted finding found, nothing fair flagged. */
const perfect = () => [
  {
    file: "hostile",
    overallRisk: "HIGH",
    findings: [
      {
        clauseExcerpt: "shall become the sole property of Client",
        severity: "HIGH",
        category: "IP",
      },
      {
        clauseExcerpt: "within ninety (90) days",
        severity: "MEDIUM",
        category: "PAYMENT",
      },
    ],
    missingClauses: ["No kill fee."],
    discardedFindings: 0,
  },
  {
    file: "mixed",
    overallRisk: "MEDIUM",
    findings: [
      { clauseExcerpt: "unlimited revisions", severity: "HIGH", category: "SCOPE" },
    ],
    missingClauses: [],
    discardedFindings: 0,
  },
  {
    file: "clean",
    overallRisk: "LOW",
    findings: [],
    missingClauses: [],
    discardedFindings: 0,
  },
];

describe("excerptsMatch (PRD §11.1's comparison rule)", () => {
  it("matches across typographic and straight apostrophes", () => {
    // The answer key uses curly quotes; post-FR-2.4 document text has
    // straight ones. String equality always fails on this pair, which is
    // why the benchmark must never use it.
    expect("Client’s acceptance").not.toBe("Client's acceptance");
    expect(excerptsMatch("Client’s acceptance", "Client's acceptance")).toBe(true);
  });

  it("matches regardless of case and collapsed whitespace", () => {
    expect(excerptsMatch("UNLIMITED   revisions", "unlimited revisions")).toBe(true);
  });

  it("matches when either side contains the other, in either direction", () => {
    expect(
      excerptsMatch(
        "the balance is due within thirty (30) days",
        "within thirty (30) days",
      ),
    ).toBe(true);
    expect(
      excerptsMatch(
        "within thirty (30) days",
        "the balance is due within thirty (30) days",
      ),
    ).toBe(true);
  });

  it("does not match a paraphrase", () => {
    expect(
      excerptsMatch("payment falls due in ninety days", "within ninety (90) days"),
    ).toBe(false);
  });

  it("is false for an empty side rather than trivially true", () => {
    // "".includes("") is true, so a naive containment check would score an
    // empty excerpt as a match against everything.
    expect(excerptsMatch("", "unlimited revisions")).toBe(false);
    expect(excerptsMatch("unlimited revisions", "")).toBe(false);
  });
});

describe("corpus selection", () => {
  it("scores only the documents the key marks accepted", () => {
    expect(acceptedDocuments(key).map((d) => d.file)).toEqual([
      "hostile",
      "mixed",
      "clean",
    ]);
  });

  it("finds the clean fixture by what the key says, not by its number", () => {
    expect(cleanDocuments(key).map((d) => d.file)).toEqual(["clean"]);
  });

  it("does not treat a document with missing protections as clean", () => {
    // "hostile" has no findings-free entry but does expect missing
    // protections; the PRD gate is zero of BOTH.
    const onlyMissing = {
      documents: [
        {
          file: "x",
          intake: "accept",
          overall_risk: "low",
          findings: [],
          missing_protections: ["a deposit"],
        },
      ],
    };
    expect(cleanDocuments(onlyMissing)).toEqual([]);
  });
});

describe("scoreRepeat", () => {
  it("scores a perfect pass at full marks", () => {
    const s = scoreRepeat(perfect(), key);
    expect(s.recallCounts).toEqual([2, 2]);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.riskCorrect).toBe(3);
    expect(s.cleanViolations).toBe(0);
    expect(s.missedHigh).toEqual([]);
  });

  it("counts only high-severity key findings toward recall", () => {
    const results = perfect();
    // Drop the medium-severity finding; recall must be unaffected.
    results[0].findings = results[0].findings.filter((f) => f.severity === "HIGH");
    const s = scoreRepeat(results, key);
    expect(s.recallCounts).toEqual([2, 2]);
  });

  it("records a missed high-severity finding with the key's reason", () => {
    const results = perfect();
    results[1].findings = [];
    const s = scoreRepeat(results, key);
    expect(s.recallCounts).toEqual([1, 2]);
    expect(s.missedHigh).toEqual([{ file: "mixed", category: "scope", why: "no cap" }]);
  });

  it("counts a flagged fair clause against precision, naming it", () => {
    const results = perfect();
    results[1].findings.push({
      clauseExcerpt: "Fifty percent (50%) is due upon execution",
      severity: "LOW",
      category: "PAYMENT",
    });
    const s = scoreRepeat(results, key);
    expect(s.precisionCounts).toEqual([1, 2]);
    expect(s.flaggedFair).toEqual([{ file: "mixed", why: "deposit, favourable" }]);
  });

  it("counts a fair clause flagged by a fragment of itself", () => {
    // The real failure this models: the model quoted half a clause, and
    // the half it quoted inverted the clause's meaning.
    const results = perfect();
    results[1].findings.push({
      clauseExcerpt: "due upon execution",
      severity: "LOW",
      category: "PAYMENT",
    });
    expect(scoreRepeat(results, key).precisionCounts).toEqual([1, 2]);
  });

  it("fails the clean gate on BOTH halves, not findings alone", () => {
    const withFinding = perfect();
    withFinding[2].findings = [
      {
        clauseExcerpt: "fourteen (14) days written notice",
        severity: "LOW",
        category: "TERMINATION",
      },
    ];
    expect(scoreRepeat(withFinding, key).cleanViolations).toBe(1);

    const withMissing = perfect();
    withMissing[2].missingClauses = ["No cap on scope-change requests."];
    expect(scoreRepeat(withMissing, key).cleanViolations).toBe(1);

    const withBoth = perfect();
    withBoth[2].findings = [{ clauseExcerpt: "x", severity: "LOW", category: "OTHER" }];
    withBoth[2].missingClauses = ["y"];
    expect(scoreRepeat(withBoth, key).cleanViolations).toBe(2);
  });

  it("accepts an also_acceptable finding without counting it a false positive", () => {
    const results = perfect();
    results[1].findings.push({
      clauseExcerpt: "courts of Delaware",
      severity: "LOW",
      category: "DISPUTE",
    });
    const s = scoreRepeat(results, key);
    expect(s.precision).toBe(1);
    expect(s.broadPrecision).toBe(1);
  });

  it("reports the discard rate over findings the model produced, not those that survived", () => {
    const results = perfect();
    results[0].discardedFindings = 2; // 2 discarded, 3 verified across the corpus
    expect(scoreRepeat(results, key).discardRate).toBeCloseTo(2 / 5);
  });

  it("refuses to score a document the answer key does not describe", () => {
    const results = perfect();
    results[0].file = "not-in-the-key";
    expect(() => scoreRepeat(results, key)).toThrow(/no answer-key entry/);
  });
});

describe("spread", () => {
  it("reports a stable metric as stable", () => {
    expect(spread([1, 1, 1])).toMatchObject({
      mean: 1,
      lo: 1,
      hi: 1,
      stable: true,
      n: 3,
    });
  });

  it("reports the range, which is the reason repeats exist", () => {
    expect(spread([0.6, 1, 0.8])).toMatchObject({ lo: 0.6, hi: 1, stable: false });
  });

  it("ignores metrics the corpus cannot supply rather than scoring them zero", () => {
    expect(spread([null, 0.5, null])).toMatchObject({ mean: 0.5, n: 1 });
    expect(spread([null, null])).toBeNull();
  });
});

describe("evaluateGates (PRD §11.1)", () => {
  const gate = (gates, fragment) => gates.find((g) => g.name.includes(fragment));

  it("passes every gate on repeated perfect runs", () => {
    const gates = evaluateGates([
      scoreRepeat(perfect(), key),
      scoreRepeat(perfect(), key),
    ]);
    expect(gates.every((g) => g.verdict === "PASS")).toBe(true);
  });

  it("judges the WORST repeat, never the mean", () => {
    // This is the whole point: a gate that flaps one run in three is not
    // passing, and a mean over three runs rounds that away.
    const bad = perfect();
    bad[2].findings = [
      { clauseExcerpt: "fourteen (14) days", severity: "LOW", category: "TERMINATION" },
    ];
    const gates = evaluateGates([
      scoreRepeat(perfect(), key),
      scoreRepeat(perfect(), key),
      scoreRepeat(bad, key),
    ]);
    expect(gate(gates, "Clean contract").verdict).toBe("FAIL");
  });

  it("warns between the target and the blocking threshold, and fails below it", () => {
    const missOne = () => {
      const r = perfect();
      r[1].findings = [];
      return scoreRepeat(r, key);
    };
    // 1 of 2 high-severity found = 50%, well under the 85% blocking line.
    expect(gate(evaluateGates([missOne()]), "Recall").verdict).toBe("FAIL");

    // A hand-built repeat at exactly 88%: above blocking, below target.
    const warnish = { ...scoreRepeat(perfect(), key), recall: 0.88 };
    expect(gate(evaluateGates([warnish]), "Recall").verdict).toBe("WARN");
  });

  it("marks a metric the corpus cannot measure as SKIPPED, never as passing", () => {
    // A corpus with no fair clauses must not report 100% precision.
    const noFair = {
      documents: key.documents.map((d) => ({ ...d, fair_clauses_do_not_flag: [] })),
    };
    const gates = evaluateGates([scoreRepeat(perfect(), noFair)]);
    expect(gate(gates, "Precision").verdict).toBe("SKIPPED");
  });

  it("fails when any document's risk is wrong in any repeat", () => {
    const wrong = perfect();
    wrong[0].overallRisk = "MEDIUM";
    const gates = evaluateGates([scoreRepeat(perfect(), key), scoreRepeat(wrong, key)]);
    expect(gate(gates, "overallRisk").verdict).toBe("FAIL");
  });
});
