import { describe, it, expect } from "vitest";
import { MockLlmProvider } from "../../src/services/llm/mockProvider.js";
import { APIUserAbortError, RateLimitError, InternalServerError, AuthenticationError } from "@anthropic-ai/sdk";

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
    provider.scriptValidResponse({ overall_risk: "high", document_type: "Test Agreement" });

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
    expect(parsed.findings[0].clause_excerpt).toBe("this text is nowhere in the source document");
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
  ])("scripts a %i provider HTTP error as the SDK's own %s", async (status, ErrorClass) => {
    const provider = new MockLlmProvider();
    provider.scriptHttpError(status);

    const err = await provider.analyze({}).catch((e) => e);
    expect(err).toBeInstanceOf(ErrorClass);
    expect(err.status).toBe(status);
  });

  it("consumes scripts in order — retries see the SECOND scripted response", async () => {
    const provider = new MockLlmProvider();
    provider.scriptMalformedJson().scriptValidResponse({ document_type: "Retry succeeded" });

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
