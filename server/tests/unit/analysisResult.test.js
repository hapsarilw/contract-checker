import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AnalysisResult,
  Finding,
  parseAnalysisResult,
} from "../../src/schemas/analysisResult.js";
import { retryCorrection } from "../../src/prompts/analyze.js";
import { normalizeForMatch, verifyFindings } from "../../src/services/verify.js";
import { deriveOverallRisk } from "../../src/services/risk.js";
import { MockLlmProvider } from "../../src/services/llm/mockProvider.js";

/**
 * TR-2 (SRS §10.1) — the LLM output contract (§5.2, FR-3.2).
 *
 * The valid payload, the enums and every bound are read from §5.2 in
 * docs/SRS.md rather than restated here, so the spec and the schema cannot
 * drift apart without a failing test.
 */
const SRS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "SRS.md"),
  "utf8",
);
const FENCE = "`".repeat(3);

function section52() {
  const start = SRS.indexOf("### 5.2 LLM output contract");
  const end = SRS.indexOf("### 5.3 Excerpt verification");
  if (start < 0 || end < start) throw new Error("docs/SRS.md: §5.2 not found");
  return SRS.slice(start, end);
}

function fencedBlock(language) {
  const section = section52();
  const open = section.indexOf(FENCE + language + "\n");
  if (open < 0) throw new Error(`docs/SRS.md §5.2: no ${language} block`);
  const start = open + FENCE.length + language.length + 1;
  return section.slice(start, section.indexOf("\n" + FENCE, start));
}

const SPEC_EXAMPLE_TEXT = fencedBlock("json");
const SPEC_SCHEMA_SOURCE = fencedBlock("js");
const [FINDING_SOURCE, RESULT_SOURCE] = SPEC_SCHEMA_SOURCE.split("const AnalysisResult");

/** A fresh copy of §5.2's example response. */
function specExample() {
  return JSON.parse(SPEC_EXAMPLE_TEXT);
}

function stringBounds(source, where) {
  return [
    ...source.matchAll(/^\s*(\w+): z\.string\(\)((?:\.(?:min|max)\(\d+\))+),?$/gm),
  ].map((match) => ({
    field: match[1],
    where,
    min: Number(match[2].match(/\.min\((\d+)\)/)?.[1] ?? 0),
    max: Number(match[2].match(/\.max\((\d+)\)/)?.[1]),
  }));
}

const SPEC_STRING_BOUNDS = [
  ...stringBounds(FINDING_SOURCE, "finding"),
  ...stringBounds(RESULT_SOURCE, "result"),
];

function specEnum(field) {
  const match = SPEC_SCHEMA_SOURCE.match(
    new RegExp(field + ": z\\.enum\\(\\[([^\\]]+)\\]\\)"),
  );
  if (!match) throw new Error(`docs/SRS.md §5.2: no z.enum for ${field}`);
  return match[1].split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
}

function specArrayMax(field) {
  const match = RESULT_SOURCE.match(
    new RegExp(field + ": z\\.array\\(.+\\)\\.max\\((\\d+)\\)"),
  );
  if (!match) throw new Error(`docs/SRS.md §5.2: no array bound for ${field}`);
  return Number(match[1]);
}

const SPEC_MISSING_CLAUSE_MAX = Number(
  RESULT_SOURCE.match(/missing_clauses: z\.array\(z\.string\(\)\.max\((\d+)\)\)/)?.[1],
);

/** Parses a value the way the model sends it: as JSON text. */
function parse(value) {
  return parseAnalysisResult(JSON.stringify(value));
}

function withField(where, field, value) {
  const result = specExample();
  if (where === "result") result[field] = value;
  else result.findings[0][field] = value;
  return result;
}

function pathPrefix(where, field) {
  return new RegExp(`^${where === "result" ? field : `findings\\.0\\.${field}`}: `);
}

function errorSummaryOf(parsed) {
  if (parsed.success) throw new Error("expected the response to fail validation");
  return parsed.errorSummary;
}

describe("TR-2 — the LLM output contract (§5.2)", () => {
  it("1. a valid payload parses — §5.2's own example response", () => {
    expect(parseAnalysisResult(SPEC_EXAMPLE_TEXT)).toEqual({
      success: true,
      data: specExample(),
    });
  });

  describe("2. a missing field fails, naming the field", () => {
    it.each(Object.keys(specExample()))("top-level %s", (field) => {
      const result = specExample();
      delete result[field];
      const summary = errorSummaryOf(parse(result));
      expect(summary).toMatch(pathPrefix("result", field));
      expect(summary.split("; ")).toHaveLength(1);
    });

    it.each(Object.keys(specExample().findings[0]))("finding %s", (field) => {
      const result = specExample();
      delete result.findings[0][field];
      const summary = errorSummaryOf(parse(result));
      expect(summary).toMatch(pathPrefix("finding", field));
      expect(summary.split("; ")).toHaveLength(1);
    });
  });

  describe("3. a wrong enum value fails", () => {
    it.each([
      ["overall_risk", "result", "critical"],
      ["severity", "finding", "critical"],
      ["category", "finding", "legal"],
    ])("%s", (field, where, value) => {
      expect(errorSummaryOf(parse(withField(where, field, value)))).toMatch(
        pathPrefix(where, field),
      );
    });

    it("uppercase is a wrong value too — §5.2's enums are lowercase, unlike Prisma's", () => {
      expect(parse(withField("result", "overall_risk", "HIGH")).success).toBe(false);
      expect(parse(withField("finding", "severity", "HIGH")).success).toBe(false);
    });
  });

  it("4. an excerpt over 300 characters fails", () => {
    expect(
      SPEC_STRING_BOUNDS.find((bound) => bound.field === "clause_excerpt")?.max,
    ).toBe(300);
    expect(parse(withField("finding", "clause_excerpt", "x".repeat(300))).success).toBe(
      true,
    );
    expect(
      errorSummaryOf(parse(withField("finding", "clause_excerpt", "x".repeat(301)))),
    ).toMatch(pathPrefix("finding", "clause_excerpt"));
  });

  describe("5. an unexpected extra key is REJECTED by .strict()", () => {
    it("at the top level, naming the key in the correction", () => {
      const summary = errorSummaryOf(parse({ ...specExample(), confidence: 0.9 }));
      expect(summary).toMatch(/^response: /);
      expect(summary).toContain('"confidence"');
    });

    it("including a __proto__ key, which is rejected rather than set", () => {
      const text = SPEC_EXAMPLE_TEXT.replace("{", '{"__proto__": {"polluted": true},');
      expect(errorSummaryOf(parseAnalysisResult(text))).toContain('"__proto__"');
    });

    it("§5.2 makes only AnalysisResult strict — an unknown key inside a finding is stripped", () => {
      // Pinned, not endorsed. §5.2's drift rationale applies inside findings
      // too, but the spec as written makes only the top level strict; this
      // should change together with §5.2, never by accident.
      expect(
        /const AnalysisResult = z\.object\(\{[\s\S]*?\}\)\.strict\(\);/.test(
          SPEC_SCHEMA_SOURCE,
        ),
      ).toBe(true);
      expect(FINDING_SOURCE).not.toContain(".strict()");

      const result = specExample();
      result.findings[0].confidence = 0.9;
      expect(parse(result)).toEqual({ success: true, data: specExample() });
    });
  });

  describe("6. a fenced response parses after stripping, without spending the retry", () => {
    it.each([
      ["a json-tagged fence", (json) => `${FENCE}json\n${json}\n${FENCE}`],
      ["an untagged fence", (json) => `${FENCE}\n${json}\n${FENCE}`],
      [
        "an uppercase tag and CRLF line endings",
        (json) => `${FENCE}JSON\r\n${json}\r\n${FENCE}\r\n`,
      ],
      [
        "whitespace around the fences",
        (json) => `  \n${FENCE}json  \n${json}\n${FENCE}   \n`,
      ],
      ["only a leading fence", (json) => `${FENCE}json\n${json}\n`],
      ["only a trailing fence", (json) => `${json}\n${FENCE}`],
      ["fences with no line breaks", (json) => `${FENCE}json${json}${FENCE}`],
    ])("%s", (_label, wrap) => {
      expect(parseAnalysisResult(wrap(SPEC_EXAMPLE_TEXT))).toEqual({
        success: true,
        data: specExample(),
      });
    });

    it("leaves fence characters inside a valid response's strings untouched", () => {
      const result = specExample();
      result.summary = `The contract embeds ${FENCE}code${FENCE} blocks, which is odd but harmless.`;
      expect(parse(result)).toEqual({ success: true, data: result });
    });

    it.each([
      [
        "prose before the fence",
        (json) => `Here is the analysis:\n${FENCE}json\n${json}\n${FENCE}`,
      ],
      [
        "prose after the fence",
        (json) => `${FENCE}json\n${json}\n${FENCE}\nLet me know if you need more.`,
      ],
      ["prose with no fence", (json) => `Here is the analysis: ${json}`],
    ])("does not rescue %s — FR-3.1 forbids it, so it uses the retry", (_label, wrap) => {
      expect(errorSummaryOf(parseAnalysisResult(wrap(SPEC_EXAMPLE_TEXT)))).toMatch(
        /^not valid JSON \(/,
      );
    });
  });
});

describe("every string and array bound in §5.2 is enforced", () => {
  it("reads its bounds from §5.2: five strings, two arrays and the missing_clauses entries", () => {
    expect(SPEC_STRING_BOUNDS.map((bound) => bound.field)).toEqual([
      "clause_excerpt",
      "explanation",
      "suggested_change",
      "document_type",
      "summary",
    ]);
    for (const max of [
      specArrayMax("findings"),
      specArrayMax("missing_clauses"),
      SPEC_MISSING_CLAUSE_MAX,
    ]) {
      expect(Number.isInteger(max) && max > 0).toBe(true);
    }
  });

  describe.each(SPEC_STRING_BOUNDS)(
    "$field (min $min, max $max)",
    ({ field, where, min, max }) => {
      it("accepts exactly the maximum and rejects one character more", () => {
        expect(parse(withField(where, field, "x".repeat(max))).success).toBe(true);
        expect(
          errorSummaryOf(parse(withField(where, field, "x".repeat(max + 1)))),
        ).toMatch(pathPrefix(where, field));
      });

      it("accepts exactly the minimum and rejects one character fewer", () => {
        expect(parse(withField(where, field, "x".repeat(min))).success).toBe(true);
        if (min === 0) return; // §5.2 sets no floor on this field
        expect(
          errorSummaryOf(parse(withField(where, field, "x".repeat(min - 1)))),
        ).toMatch(pathPrefix(where, field));
      });
    },
  );

  it("rejects a 40 KB explanation without echoing it back in the correction", () => {
    const summary = errorSummaryOf(
      parse(withField("finding", "explanation", "x".repeat(40_000))),
    );
    expect(summary).toMatch(pathPrefix("finding", "explanation"));
    expect(summary.length).toBeLessThan(300);
  });

  it("findings accepts its maximum count and rejects one more", () => {
    const max = specArrayMax("findings");
    const withCount = (count) => ({
      ...specExample(),
      findings: Array.from({ length: count }, () => specExample().findings[0]),
    });
    expect(parse(withCount(max)).success).toBe(true);
    expect(errorSummaryOf(parse(withCount(max + 1)))).toMatch(/^findings: /);
  });

  it("missing_clauses accepts its maximum count and rejects one more", () => {
    const max = specArrayMax("missing_clauses");
    const withCount = (count) => ({
      ...specExample(),
      missing_clauses: Array.from({ length: count }, () => "No kill fee is specified."),
    });
    expect(parse(withCount(max)).success).toBe(true);
    expect(errorSummaryOf(parse(withCount(max + 1)))).toMatch(/^missing_clauses: /);
  });

  it("a missing_clauses entry accepts its maximum length and rejects one more", () => {
    const withEntry = (length) => ({
      ...specExample(),
      missing_clauses: ["x".repeat(length)],
    });
    expect(parse(withEntry(SPEC_MISSING_CLAUSE_MAX)).success).toBe(true);
    expect(errorSummaryOf(parse(withEntry(SPEC_MISSING_CLAUSE_MAX + 1)))).toMatch(
      /^missing_clauses\.0: /,
    );
  });

  it("category, severity and overall_risk have exactly §5.2's values", () => {
    expect(Finding.shape.category.options).toEqual(specEnum("category"));
    expect(Finding.shape.severity.options).toEqual(specEnum("severity"));
    expect(AnalysisResult.shape.overall_risk.options).toEqual(specEnum("overall_risk"));
  });
});

describe("the error summary sent back in the retry correction (§2.2 step 6)", () => {
  it("never ends with a period, because retryCorrection()'s template supplies one", () => {
    for (const text of [
      "",
      "not json at all.",
      JSON.stringify([]),
      JSON.stringify({ ...specExample(), overall_risk: "x" }),
    ]) {
      const summary = errorSummaryOf(parseAnalysisResult(text));
      expect(summary).not.toMatch(/\.$/);
      expect(retryCorrection(summary).split("\n")[0]).toMatch(/[^.]\.$/);
    }
  });

  it("names the path of each failing field", () => {
    const result = specExample();
    result.overall_risk = "critical";
    result.findings[0].clause_excerpt = "short";
    const paths = errorSummaryOf(parse(result))
      .split("; ")
      .map((line) => line.split(": ")[0]);
    expect(paths.sort()).toEqual(["findings.0.clause_excerpt", "overall_risk"]);
  });

  it("labels a whole-response failure 'response'", () => {
    expect(errorSummaryOf(parseAnalysisResult("[]"))).toMatch(/^response: /);
  });

  it("reports a wrong-typed field once, without Zod's misleading length check on it", () => {
    // Longer than findings' maximum item count, so Zod 4's length check
    // also fires on the string and produces the sibling issue being filtered.
    const wrongType = {
      ...specExample(),
      findings: "x".repeat(specArrayMax("findings") + 1),
    };
    const raw = AnalysisResult.safeParse(wrongType);
    expect(raw.error?.issues.map((issue) => issue.code)).toEqual([
      "invalid_type",
      "too_big",
    ]);

    const summary = errorSummaryOf(parse(wrongType));
    expect(summary.split("; ")).toHaveLength(1);
    expect(summary).toMatch(/^findings: /);
    expect(summary).not.toContain("<=");
  });

  it("quotes at most ten issues and counts the rest", () => {
    const result = specExample();
    result.findings = Array.from({ length: 12 }, () => ({
      ...specExample().findings[0],
      severity: "critical",
    }));
    const summary = errorSummaryOf(parse(result));
    expect(summary.split("; ")).toHaveLength(11);
    expect(summary).toMatch(/; and 2 more$/);
  });

  it("truncates a model-controlled key name, so the correction stays small", () => {
    const text = SPEC_EXAMPLE_TEXT.replace("{", `{"${"k".repeat(10_000)}": 1,`);
    const summary = errorSummaryOf(parseAnalysisResult(text));
    expect(summary).toMatch(/ \[truncated\]$/);
    expect(summary.length).toBeLessThan(300);
  });

  it("describes a non-JSON response without echoing it at length", () => {
    const summary = errorSummaryOf(
      parseAnalysisResult("I can't help with that. ".repeat(500)),
    );
    expect(summary).toMatch(/^not valid JSON \(/);
    expect(summary.length).toBeLessThan(300);
  });
});

describe("fits the modules either side of it", () => {
  it("parsed findings flow into verifyFindings and deriveOverallRisk with no casts", () => {
    // Also a typecheck-time check: if a severity were typed as a plain
    // string, deriveOverallRisk(verified) would stop compiling.
    const parsed = parseAnalysisResult(SPEC_EXAMPLE_TEXT);
    if (!parsed.success) throw new Error(parsed.errorSummary);
    const documentText = `Preamble.\n${parsed.data.findings[0].clause_excerpt}\nMore text.`;

    const { verified, discardedCount } = verifyFindings(
      parsed.data.findings,
      normalizeForMatch(documentText),
    );

    expect(discardedCount).toBe(0);
    expect(deriveOverallRisk(verified)).toBe("HIGH");
  });

  const rawTextOf = async (script) =>
    (
      await script(new MockLlmProvider()).analyze({
        documentText: "x",
        requestId: "test",
      })
    ).rawText;

  it.each([
    ["a valid response", (mock) => mock.scriptValidResponse()],
    ["a valid fenced response", (mock) => mock.scriptValidResponse({}, { fenced: true })],
    [
      "fabricated excerpts, which only the verifier catches",
      (mock) => mock.scriptFabricatedExcerpts(),
    ],
  ])("parses the mock provider's %s", async (_label, script) => {
    expect(parseAnalysisResult(await rawTextOf(script)).success).toBe(true);
  });

  it.each([
    ["malformed JSON", (mock) => mock.scriptMalformedJson()],
    ["extra key", (mock) => mock.scriptSchemaInvalid({ reason: "extra_key" })],
    ["wrong enum", (mock) => mock.scriptSchemaInvalid({ reason: "wrong_enum" })],
    ["missing field", (mock) => mock.scriptSchemaInvalid({ reason: "missing_field" })],
  ])("rejects the mock provider's %s", async (_label, script) => {
    expect(parseAnalysisResult(await rawTextOf(script)).success).toBe(false);
  });
});
