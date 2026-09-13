import { describe, it, expect, vi } from "vitest";
import {
  normalizeForMatch,
  excerptAppears,
  verifyFindings,
} from "../../src/services/verify.js";
import { normalize } from "../../src/services/extraction.js";

/**
 * TR-3 (SRS §10.1) — excerpt verification, the product's central safety
 * control (§5.3, FR-3.3).
 *
 * On coverage: §10.5 requires 100% BRANCH coverage on verify.js, and
 * vitest.config.js enforces it. Treat the number as nearly free. The
 * normaliser is a branchless regex chain — a version whose curly-quote
 * class had been flattened to ASCII, a silent no-op, still scores 100%
 * (checked) — and the module's one branch is the empty-excerpt guard, so
 * two calls, one empty excerpt and one not, reach the threshold while
 * testing none of TR-3. TR-3's six cases are the real gate.
 */

// Synthetic, as §11.3 requires of every fixture: no real party, company or
// person. Shaped the way FR-2.4 stores text — straight quotes and hyphens,
// paragraph breaks kept — with clause 2 hard-wrapped mid-sentence the way
// PDF extraction emits a visual line end.
const DESIGN_AGREEMENT = [
  "DESIGN SERVICES AGREEMENT",
  "1. Scope. The Designer will deliver up to three (3) initial concepts for the Client's review.",
  "2. Revisions. The Client may request unlimited revisions at no additional\ncost until the Client, in its sole discretion, approves the final design.",
  "3. Payment. Invoices are payable within ninety (90) days of receipt. Late payments shall not accrue interest.",
  '4. Ownership. All work product (the "Deliverables"), including rejected concepts, becomes the exclusive property of the Client upon creation - whether or not payment has been made.',
  "5. Warranty. The Deliverables are provided 'as is', without warranty of any kind.",
  "6. Termination. The Client may terminate this Agreement at any time, for any reason, without payment for work in progress.",
].join("\n\n");

const DEVELOPMENT_AGREEMENT = [
  "SOFTWARE DEVELOPMENT AGREEMENT",
  "7. Non-Compete. For twenty-four (24) months after termination, the Developer shall not provide services to any business that competes with the Company.",
  "8. Termination. The Company may terminate this Agreement at any time, with thirty (30) days' written notice.",
].join("\n\n");

const NORMALIZED_DESIGN_AGREEMENT = normalizeForMatch(DESIGN_AGREEMENT);

/**
 * Runs one excerpt through BOTH exports and requires them to agree, so
 * every case holds for production's verifyFindings and for any check built
 * on excerptAppears alike.
 */
function verdict(excerpt, docText) {
  const appears = excerptAppears(excerpt, docText);
  const { verified } = verifyFindings(
    [{ clause_excerpt: excerpt }],
    normalizeForMatch(docText),
  );
  expect(verified.length === 1, "excerptAppears and verifyFindings disagree").toBe(
    appears,
  );
  return appears;
}

/** A "variant" that is already an exact substring passes without normalisation and proves nothing. */
function expectVariantPasses(excerpt, docText) {
  expect(docText.includes(excerpt), "not a variant: already an exact substring").toBe(
    false,
  );
  expect(verdict(excerpt, docText)).toBe(true);
}

describe("TR-3 — excerpt verification (§5.3, FR-3.3)", () => {
  it("1. an exact match passes", () => {
    expect(
      verdict(
        "Invoices are payable within ninety (90) days of receipt.",
        DESIGN_AGREEMENT,
      ),
    ).toBe(true);
    expect(
      verdict(
        'All work product (the "Deliverables"), including rejected concepts, becomes the exclusive property of the Client upon creation - whether or not payment has been made.',
        DESIGN_AGREEMENT,
      ),
    ).toBe(true);
  });

  describe("2. a case or whitespace variant passes", () => {
    it.each([
      ["different case", "INVOICES ARE PAYABLE within Ninety (90) DAYS of receipt."],
      [
        "runs of spaces, tabs and newlines",
        "Invoices  are\tpayable\n\nwithin ninety (90)   days of receipt.",
      ],
      [
        "leading and trailing whitespace",
        "   Invoices are payable within ninety (90) days of receipt.\n",
      ],
      [
        "a non-breaking space, which PDF extraction and models both emit",
        "Invoices are payable within ninety (90)\u00A0days of receipt.",
      ],
      [
        "one space where the document has a hard line break",
        "at no additional cost until the Client, in its sole discretion",
      ],
    ])("%s", (_label, excerpt) => {
      expectVariantPasses(excerpt, DESIGN_AGREEMENT);
    });
  });

  describe("3. a curly-quote variant passes", () => {
    it.each([
      [
        "a U+2019 apostrophe in the excerpt",
        "for the Client\u2019s review",
        DESIGN_AGREEMENT,
      ],
      [
        "U+2018/U+2019 single quotes in the excerpt",
        "provided \u2018as is\u2019, without warranty",
        DESIGN_AGREEMENT,
      ],
      [
        "U+201C/U+201D double quotes in the excerpt",
        "(the \u201CDeliverables\u201D)",
        DESIGN_AGREEMENT,
      ],
      // FR-2.4 folds quotes before a document is stored, so production only
      // reaches this branch from the excerpt side and the fixture corpus
      // cannot reach the document side at all. It is still §5.3's contract,
      // and these rows are the only place it is exercised.
      [
        "a U+2019 apostrophe in the document",
        "for the Client's review",
        DESIGN_AGREEMENT.replaceAll("'", "\u2019"),
      ],
      [
        "U+201C/U+201D double quotes in the document",
        '(the "Deliverables")',
        DESIGN_AGREEMENT.replace('"Deliverables"', "\u201CDeliverables\u201D"),
      ],
    ])("%s", (_label, excerpt, docText) => {
      expectVariantPasses(excerpt, docText);
    });

    it.each([
      ["U+2014 em dash", "upon creation \u2014 whether or not payment has been made"],
      ["U+2013 en dash", "upon creation \u2013 whether or not payment has been made"],
    ])(
      "and so does a %s where the document has a hyphen — §5.3's dash fold",
      (_label, excerpt) => {
        expectVariantPasses(excerpt, DESIGN_AGREEMENT);
      },
    );
  });

  describe("4. a fabricated excerpt is discarded", () => {
    it.each([
      [
        "invented outright, in the document's own register",
        "The Designer shall pay a penalty of $500 for each day the final design is late.",
        [],
      ],
      [
        "stitched together from two real clauses",
        "The Client may request unlimited revisions without payment for work in progress.",
        [
          "The Client may request unlimited revisions",
          "without payment for work in progress.",
        ],
      ],
      [
        "a real clause with its meaning inverted",
        "Late payments shall accrue interest.",
        ["Late payments shall not accrue interest."],
      ],
    ])("%s", (_label, excerpt, realParts) => {
      // Real text a fabrication was built from is shown to be real first, so
      // the discard is the matcher refusing the fabrication — not a typo here.
      for (const part of realParts) expect(verdict(part, DESIGN_AGREEMENT)).toBe(true);
      expect(verdict(excerpt, DESIGN_AGREEMENT)).toBe(false);
    });
  });

  describe("5. an excerpt from a DIFFERENT document is discarded", () => {
    it.each([
      [
        "a clause with no counterpart in this document",
        "the Developer shall not provide services to any business that competes with the Company",
      ],
      // The hard version: its first seven words match this document's own
      // termination clause.
      [
        "boilerplate nearly identical to a clause this document has",
        "may terminate this Agreement at any time, with thirty (30) days' written notice",
      ],
    ])("%s", (_label, excerpt) => {
      // Verbatim from its own document, so the discard is about WHICH
      // document it was checked against.
      expect(verdict(excerpt, DEVELOPMENT_AGREEMENT)).toBe(true);
      expect(verdict(excerpt, DESIGN_AGREEMENT)).toBe(false);
    });
  });

  describe("6. a PARAPHRASE of a real clause in the same document is discarded", () => {
    // The significant case: every row is a near miss a fuzzy matcher would
    // wrongly admit (PRD D9). Each asserts its real clause passes first.
    const REVISIONS = "The Client may request unlimited revisions at no additional cost";
    const PAYMENT = "Invoices are payable within ninety (90) days of receipt.";
    const DISCRETION =
      "until the Client, in its sole discretion, approves the final design";
    const REVIEW = "for the Client's review";

    it.each([
      [
        "reworded throughout",
        REVISIONS,
        "The Client can ask for as many revisions as it likes without paying anything extra",
      ],
      [
        "one synonym swapped",
        REVISIONS,
        "The Client may request unlimited revisions at no extra cost",
      ],
      [
        "one modal verb swapped",
        REVISIONS,
        "The Client can request unlimited revisions at no additional cost",
      ],
      [
        "one word dropped",
        REVISIONS,
        "The Client may request unlimited revisions at no cost",
      ],
      [
        "one word inserted",
        REVISIONS,
        "The Client may request unlimited free revisions at no additional cost",
      ],
      [
        "its parts reordered",
        REVISIONS,
        "at no additional cost, the Client may request unlimited revisions",
      ],
      [
        "a one-letter typo",
        REVISIONS,
        "The Client may request unlimted revisions at no additional cost",
      ],
      [
        "a number rewritten as digits",
        PAYMENT,
        "Invoices are payable within 90 days of receipt.",
      ],
      [
        "its commas dropped — punctuation beyond quotes and dashes is significant",
        DISCRETION,
        "until the Client in its sole discretion approves the final design",
      ],
      ["an apostrophe dropped rather than restyled", REVIEW, "for the Clients review"],
    ])("%s", (_label, realClause, paraphrase) => {
      expect(verdict(realClause, DESIGN_AGREEMENT)).toBe(true);
      expect(verdict(paraphrase, DESIGN_AGREEMENT)).toBe(false);
    });
  });
});

describe("the empty-excerpt guard (§5.3)", () => {
  it.each([
    ["the empty string", ""],
    ["ten spaces, which pass §5.2's clause_excerpt .min(10)", " ".repeat(10)],
    ["newlines and tabs", "\n\t".repeat(5)],
    ["non-breaking spaces", "\u00A0".repeat(10)],
  ])("discards an excerpt that is %s", (_label, excerpt) => {
    // Why the guard exists: the bare comparison admits this, because every
    // string includes the empty string.
    expect(NORMALIZED_DESIGN_AGREEMENT.includes(normalizeForMatch(excerpt))).toBe(true);
    expect(verdict(excerpt, DESIGN_AGREEMENT)).toBe(false);
  });
});

describe("verifyFindings — the orchestrator's entry point", () => {
  const real = {
    clause_excerpt: "Invoices are payable within ninety (90) days of receipt.",
  };
  const variant = { clause_excerpt: "for the Client\u2019s review" };
  const fabricated = {
    clause_excerpt:
      "The Designer shall pay a penalty of $500 for each day the final design is late.",
  };

  it("returns the verified findings as the same objects, in their original order, and counts the rest", () => {
    const findings = [fabricated, real, fabricated, variant];

    const result = verifyFindings(findings, NORMALIZED_DESIGN_AGREEMENT);

    expect(result.verified).toHaveLength(2);
    expect(result.verified[0]).toBe(real);
    expect(result.verified[1]).toBe(variant);
    expect(result.discardedCount).toBe(2);
    expect(findings).toEqual([fabricated, real, fabricated, variant]);
  });

  it("discards nothing from an empty findings array — a clean contract is not a failure here", () => {
    expect(verifyFindings([], NORMALIZED_DESIGN_AGREEMENT)).toEqual({
      verified: [],
      discardedCount: 0,
    });
  });

  it("discards every finding when every excerpt is fabricated — the input TR-7 must turn into ALL_FINDINGS_DISCARDED", () => {
    const stitched = {
      clause_excerpt:
        "The Client may request unlimited revisions without payment for work in progress.",
    };
    expect(verifyFindings([fabricated, stitched], NORMALIZED_DESIGN_AGREEMENT)).toEqual({
      verified: [],
      discardedCount: 2,
    });
  });

  describe("the document is normalised once per analysis, by the caller (§5.3)", () => {
    it("rejects a raw document at typecheck, and fails closed if one gets past it", () => {
      // If this line stops being a type error, the directive is reported as
      // unused and `npm run typecheck` fails: the signature would no longer
      // force the caller to normalise.
      // @ts-expect-error — a plain string is not NormalizedForMatch
      const raw = verifyFindings([real], DESIGN_AGREEMENT);

      // The document is used exactly as given. Raw text keeps "Invoices"
      // capitalised, so the lowercased excerpt is not found: discarded, never
      // wrongly admitted.
      expect(raw).toEqual({ verified: [], discardedCount: 1 });
      expect(verifyFindings([real], NORMALIZED_DESIGN_AGREEMENT)).toEqual({
        verified: [real],
        discardedCount: 0,
      });
    });

    it("normalises each excerpt exactly once and the document never, however many findings there are", () => {
      const findings = Array.from({ length: 25 }, (_, i) =>
        i % 2 === 0 ? { ...real } : { ...fabricated },
      );

      // normalizeForMatch starts with toLowerCase(), so the strings that
      // method is called on are exactly the strings that were normalised.
      // Captured before mockRestore(), which clears the recorded calls.
      const toLowerCase = vi.spyOn(String.prototype, "toLowerCase");
      let normalised;
      try {
        verifyFindings(findings, NORMALIZED_DESIGN_AGREEMENT);
        normalised = toLowerCase.mock.contexts.map(String);
      } finally {
        toLowerCase.mockRestore();
      }

      expect(normalised).toEqual(findings.map((finding) => finding.clause_excerpt));
    });
  });
});

describe("normalizeForMatch — §5.3, transcribed", () => {
  const FOLDED = [
    ["U+2018 left single quote", "\u2018", "'"],
    ["U+2019 right single quote, the typographic apostrophe", "\u2019", "'"],
    ["U+201C left double quote", "\u201C", '"'],
    ["U+201D right double quote", "\u201D", '"'],
    ["U+2013 en dash", "\u2013", "-"],
    ["U+2014 em dash", "\u2014", "-"],
  ];

  // Pinned, not endorsed. Folding one of these may well be reasonable, but
  // it would be a change to the matcher, and §5.3 makes every change re-run
  // the accuracy benchmark — so it should fail a test and force that
  // decision rather than slip in as a tidy-up.
  const NOT_FOLDED = [
    ["U+201A single low-9 quote", "\u201A"],
    ["U+201B single high-reversed-9 quote", "\u201B"],
    ["U+201E double low-9 quote", "\u201E"],
    ["U+2032 prime", "\u2032"],
    ["U+2010 hyphen", "\u2010"],
    ["U+2011 non-breaking hyphen", "\u2011"],
    ["U+2012 figure dash", "\u2012"],
    ["U+2015 horizontal bar", "\u2015"],
    ["U+2212 minus sign", "\u2212"],
  ];

  it("lowercases, folds quotes and dashes, collapses whitespace, and trims", () => {
    expect(
      normalizeForMatch(
        "  The CLIENT\u2019s \u201CFinal\u201D\tDesign \u2014 \n\n Net\u201330  ",
      ),
    ).toBe('the client\'s "final" design - net-30');
  });

  it.each(FOLDED)("folds %s", (_label, char, folded) => {
    expect(normalizeForMatch(`a${char}b`)).toBe(`a${folded}b`);
  });

  it.each(NOT_FOLDED)("does not fold %s", (_label, char) => {
    expect(normalizeForMatch(`a${char}b`)).toBe(`a${char}b`);
  });

  it.each([
    ["a tab", "\t"],
    ["a carriage return", "\r"],
    ["a non-breaking space", "\u00A0"],
    ["an em space", "\u2003"],
    ["a line separator (U+2028)", "\u2028"],
    ["a byte-order mark (U+FEFF)", "\uFEFF"],
  ])(
    "collapses a run containing %s — JavaScript's \\s is wider than ASCII",
    (_label, char) => {
      expect(normalizeForMatch(`a ${char}${char} b`)).toBe("a b");
    },
  );

  it("is idempotent, so normalising already-normalised text changes nothing", () => {
    const once = normalizeForMatch(DESIGN_AGREEMENT.replaceAll("'", "\u2019"));
    expect(normalizeForMatch(once)).toBe(once);
  });

  it("agrees with FR-2.4's normalize() on every character above, so stored text and matching share one idea of a quote", () => {
    for (const [label, char] of [...FOLDED, ...NOT_FOLDED]) {
      expect(normalizeForMatch(char), label).toBe(normalize(char));
    }
  });
});
