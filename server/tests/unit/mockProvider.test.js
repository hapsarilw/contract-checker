import { describe, it, expect } from "vitest";
import { APIError } from "@anthropic-ai/sdk";
import {
  MAX_RECORDED_CALLS,
  MockLlmProvider,
} from "../../src/services/llm/mockProvider.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeForMatch, verifyFindings } from "../../src/services/verify.js";
import { deriveOverallRisk } from "../../src/services/risk.js";
import {
  APIUserAbortError,
  RateLimitError,
  InternalServerError,
  AuthenticationError,
} from "@anthropic-ai/sdk";

describe("MockLlmProvider (SRS §2.3 — LLM_PROVIDER=mock)", () => {
  it("returns a valid AnalysisResult-shaped rawText by default, with no script queued", async () => {
    const provider = new MockLlmProvider();
    const result = await provider.analyze({ documentText: "x", requestId: "r1" });

    const parsed = JSON.parse(result.rawText);
    expect(parsed.document_type).toBeTypeOf("string");
    expect(parsed.overall_risk).toMatch(/^(low|medium|high)$/);
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.model).toBeTypeOf("string");
    expect(result.providerRequestId).toMatch(/^req_mock_/);
  });

  it("scripts a valid response with overrides", async () => {
    const provider = new MockLlmProvider();
    provider.scriptValidResponse({
      overall_risk: "high",
      document_type: "Test Agreement",
    });

    const result = await provider.analyze({});
    const parsed = JSON.parse(result.rawText);
    expect(parsed.overall_risk).toBe("high");
    expect(parsed.document_type).toBe("Test Agreement");
  });

  it("scripts a fenced valid response for the fence-stripping parse helper (TR-2/step 23)", async () => {
    const provider = new MockLlmProvider();
    provider.scriptValidResponse({}, { fenced: true });

    const result = await provider.analyze({});
    expect(result.rawText.startsWith("```json")).toBe(true);
    expect(result.rawText.trim().endsWith("```")).toBe(true);
    const inner = result.rawText.replace(/^```json\n/, "").replace(/\n```$/, "");
    expect(() => JSON.parse(inner)).not.toThrow();
  });

  it("scripts text that fails JSON.parse (malformed JSON)", async () => {
    const provider = new MockLlmProvider();
    provider.scriptMalformedJson();

    const result = await provider.analyze({});
    expect(() => JSON.parse(result.rawText)).toThrow(SyntaxError);
  });

  it("scripts JSON that parses but has an unexpected key (schema-invalid, .strict()'s concern)", async () => {
    const provider = new MockLlmProvider();
    provider.scriptSchemaInvalid({ reason: "extra_key" });

    const result = await provider.analyze({});
    const parsed = JSON.parse(result.rawText);
    expect(parsed).toHaveProperty("unexpected_field");
  });

  it("scripts JSON with a wrong enum value", async () => {
    const provider = new MockLlmProvider();
    provider.scriptSchemaInvalid({ reason: "wrong_enum" });

    const result = await provider.analyze({});
    const parsed = JSON.parse(result.rawText);
    expect(parsed.overall_risk).toBe("catastrophic");
  });

  it("scripts JSON missing a required field", async () => {
    const provider = new MockLlmProvider();
    provider.scriptSchemaInvalid({ reason: "missing_field" });

    const result = await provider.analyze({});
    const parsed = JSON.parse(result.rawText);
    expect(parsed).not.toHaveProperty("summary");
  });

  it("scripts a well-formed response whose excerpts do not exist in any real document", async () => {
    const provider = new MockLlmProvider();
    provider.scriptFabricatedExcerpts(["this text is nowhere in the source document"]);

    const result = await provider.analyze({});
    const parsed = JSON.parse(result.rawText);
    expect(parsed.findings[0].clause_excerpt).toBe(
      "this text is nowhere in the source document",
    );
    // Well-formed enough to pass Zod — the point is that verification
    // (§5.3, step 20), not parsing, is what should catch this.
    expect(parsed.findings[0]).toHaveProperty("category");
    expect(parsed.findings[0]).toHaveProperty("severity");
  });

  it("scripts a timeout as APIUserAbortError — what an aborted SDK call actually throws", async () => {
    const provider = new MockLlmProvider();
    provider.scriptTimeout();

    await expect(provider.analyze({})).rejects.toBeInstanceOf(APIUserAbortError);
  });

  it.each([
    [429, RateLimitError],
    [529, InternalServerError],
    [401, AuthenticationError],
  ])(
    "scripts a %i provider HTTP error as the SDK's own %s",
    async (status, ErrorClass) => {
      const provider = new MockLlmProvider();
      provider.scriptHttpError(status);

      const err = await provider.analyze({}).catch((e) => e);
      expect(err).toBeInstanceOf(ErrorClass);
      expect(err.status).toBe(status);
    },
  );

  it("consumes scripts in order — retries see the SECOND scripted response", async () => {
    const provider = new MockLlmProvider();
    provider
      .scriptMalformedJson()
      .scriptValidResponse({ document_type: "Retry succeeded" });

    const first = await provider.analyze({});
    expect(() => JSON.parse(first.rawText)).toThrow();

    const second = await provider.analyze({});
    expect(JSON.parse(second.rawText).document_type).toBe("Retry succeeded");
  });

  it("records every call, proving nothing reaches a real network — there is none to reach", async () => {
    const provider = new MockLlmProvider();
    await provider.analyze({ documentText: "doc one", requestId: "r1" });
    await provider.analyze({ documentText: "doc two", requestId: "r2" });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].documentText).toBe("doc one");
    expect(provider.calls[1].requestId).toBe("r2");
  });

  it("reset() clears both the queue and the call log", async () => {
    const provider = new MockLlmProvider();
    provider.scriptMalformedJson();
    await provider.analyze({});
    provider.reset();

    expect(provider.calls).toHaveLength(0);
    // The queue is empty again too — the next call gets the default
    // valid response, not the malformed script from before reset().
    const result = await provider.analyze({});
    expect(() => JSON.parse(result.rawText)).not.toThrow();
  });
});

describe("MockLlmProvider — delayed responses", () => {
  it("holds a scripted valid response back for delayMs", async () => {
    const provider = new MockLlmProvider();
    provider.scriptValidResponse({}, { delayMs: 60 });

    const started = Date.now();
    await provider.analyze({});
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it("delays an UNSCRIPTED analysis by the configured default (MOCK_LLM_DELAY_MS, step 71)", async () => {
    const provider = new MockLlmProvider({ defaultDelayMs: 60 });
    const started = Date.now();
    await provider.analyze({});
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("does not add the default delay to a scripted response, which keeps its own", async () => {
    const provider = new MockLlmProvider({ defaultDelayMs: 5_000 });
    provider.scriptValidResponse();
    const started = Date.now();
    await provider.analyze({});
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("has no delay at all by default", async () => {
    const started = Date.now();
    await new MockLlmProvider().analyze({});
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe("MockLlmProvider — quote-document findings (MOCK_LLM_FINDINGS, step 73)", () => {
  const DOC = [
    "SERVICES AGREEMENT",
    "The Contractor shall deliver the first draft within ten (10) business days of the kickoff meeting.",
    "Short line.",
    "Client shall pay each invoice within thirty (30) days of receipt; late amounts accrue interest at one percent per month.",
    "Either party may end this Agreement on fourteen (14) days written notice to the other party.",
    "A fourth sentence that is long enough to be quoted but should not be, because three is the most.",
  ].join("\n\n");

  it("quotes up to three whole sentences of the document, verbatim, and they survive verification", async () => {
    const provider = new MockLlmProvider({ defaultFindings: "quote-document" });
    const { rawText } = await provider.analyze({ documentText: DOC });
    const { findings } = JSON.parse(rawText);
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.severity)).toEqual(["high", "medium", "low"]);
    for (const f of findings) expect(DOC).toContain(f.clause_excerpt);
    const { verified, discardedCount } = verifyFindings(findings, normalizeForMatch(DOC));
    expect(discardedCount).toBe(0);
    expect(verified).toHaveLength(3);
  });

  it("claims the overall risk its own findings derive to, so no analysis is a risk drift (step 75)", async () => {
    const provider = new MockLlmProvider({ defaultFindings: "quote-document" });
    for (const text of [DOC, "Short line.\n\nAnother short one."]) {
      const { overall_risk, findings } = JSON.parse(
        (await provider.analyze({ documentText: text })).rawText,
      );
      expect(overall_risk.toUpperCase(), text.slice(0, 20)).toBe(
        deriveOverallRisk(findings),
      );
    }
  });

  it("is deterministic for the same document", async () => {
    const provider = new MockLlmProvider({ defaultFindings: "quote-document" });
    const a = (await provider.analyze({ documentText: DOC })).rawText;
    const b = (await provider.analyze({ documentText: DOC })).rawText;
    expect(a).toBe(b);
  });

  it("finds nothing by default, as every existing test expects", async () => {
    const { rawText } = await new MockLlmProvider().analyze({ documentText: DOC });
    expect(JSON.parse(rawText).findings).toEqual([]);
  });

  it("leaves a scripted response alone", async () => {
    const provider = new MockLlmProvider({ defaultFindings: "quote-document" });
    provider.scriptValidResponse({ findings: [] });
    expect(
      JSON.parse((await provider.analyze({ documentText: DOC })).rawText).findings,
    ).toEqual([]);
  });
});

describe("MockLlmProvider — bounded call log (step 75)", () => {
  it("remembers only the last MAX_RECORDED_CALLS calls, so a long run cannot leak documents", async () => {
    const provider = new MockLlmProvider();
    for (let i = 0; i < MAX_RECORDED_CALLS + 25; i += 1) {
      await provider.analyze({ documentText: `document ${i}`, requestId: String(i) });
    }
    expect(provider.calls).toHaveLength(MAX_RECORDED_CALLS);
    expect(provider.calls.at(-1)?.requestId).toBe(String(MAX_RECORDED_CALLS + 24));
    expect(provider.calls[0].requestId).toBe("25");
  });
});

describe("MockLlmProvider — the outage file (MOCK_LLM_OUTAGE_FILE, step 75)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mock-outage-"));
  const file = join(dir, "outage");

  it("fails every unscripted call with 529 while the file exists, and recovers when it is gone", async () => {
    const provider = new MockLlmProvider({ outageFile: file });
    await expect(provider.analyze({})).resolves.toMatchObject({
      rawText: expect.any(String),
    });
    writeFileSync(file, "");
    await expect(provider.analyze({})).rejects.toMatchObject({ status: 529 });
    rmSync(file);
    await expect(provider.analyze({})).resolves.toMatchObject({
      rawText: expect.any(String),
    });
  });

  it("fails with the status the file names", async () => {
    writeFileSync(file, "503\n");
    try {
      await expect(
        new MockLlmProvider({ outageFile: file }).analyze({}),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      rmSync(file);
    }
  });

  it("is an SDK APIError, so the retry layer and the breaker treat it as the real thing", async () => {
    writeFileSync(file, "");
    try {
      const err = await new MockLlmProvider({ outageFile: file })
        .analyze({})
        .catch((e) => e);
      expect(err).toBeInstanceOf(APIError);
    } finally {
      rmSync(file);
    }
  });

  it("leaves a scripted response alone: tests decide their own outcomes", async () => {
    writeFileSync(file, "");
    try {
      const provider = new MockLlmProvider({ outageFile: file });
      provider.scriptValidResponse();
      await expect(provider.analyze({})).resolves.toMatchObject({
        rawText: expect.any(String),
      });
    } finally {
      rmSync(file);
    }
  });
});
