import { randomUUID } from "node:crypto";
import { APIError, APIUserAbortError } from "@anthropic-ai/sdk";

/**
 * Selected by LLM_PROVIDER=mock (SRS §2.3, Appendix B). CI is configured
 * with this value so tests never reach the network — the whole test
 * suite can run with no ANTHROPIC_API_KEY that does anything.
 *
 * Interface mirrors what the real provider (server/src/services/llm/
 * client.js, step 24) will return, so swapping one for the other is
 * transparent to callers: `analyze()` resolves to
 * `{ rawText, inputTokens, outputTokens, model, durationMs, providerRequestId }`
 * or rejects with an error shaped like `@anthropic-ai/sdk` actually
 * throws (built via that SDK's own `APIError.generate` / error classes,
 * not reinvented) — verified against the installed SDK version rather
 * than guessed, since a mock that lies about the shape of a real failure
 * is worse than no mock.
 *
 * `rawText` deliberately stays a STRING, not a parsed object: per SRS
 * §2.2 steps 5–6, the provider's job ends at extracting text from the
 * API response envelope. JSON.parse and Zod validation are the
 * orchestrator's job (step 25), using schemas/analysisResult.js's parse
 * helper (step 23) — so this is also where "malformed JSON" and
 * "schema-invalid output" have to live: as different STRINGS, not as
 * different code paths in here.
 */
export class MockLlmProvider {
  #queue = [];
  calls = [];

  /** The body scriptValidResponse() serializes, factored out so the no-script default (below) can build the same shape without queueing-then-recursing into analyze(). */
  static #validResponseBody(overrides = {}) {
    return {
      document_type: overrides.document_type ?? "Independent contractor agreement",
      overall_risk: overrides.overall_risk ?? "medium",
      summary: overrides.summary ?? "This is a mocked analysis summary of sufficient length to pass validation.",
      findings: overrides.findings ?? [],
      missing_clauses: overrides.missing_clauses ?? [],
    };
  }

  /** Queues a well-formed AnalysisResult (§5.2). Each call to analyze() consumes one queued script, in order. */
  scriptValidResponse(overrides = {}, { fenced = false } = {}) {
    const json = JSON.stringify(MockLlmProvider.#validResponseBody(overrides));
    this.#queue.push({ kind: "text", text: fenced ? "```json\n" + json + "\n```" : json });
    return this;
  }

  /** Queues text that fails JSON.parse outright — unquoted keys, a trailing comma, or similar. */
  scriptMalformedJson() {
    this.#queue.push({
      kind: "text",
      text: '{"document_type": "Broken", overall_risk: "high", "summary": "no closing quote}',
    });
    return this;
  }

  /**
   * Queues syntactically valid JSON that fails the §5.2 Zod schema —
   * default violation is an unexpected extra key, which only .strict()
   * catches (TR-2's specific concern; .passthrough() or a plain
   * .object() would silently let this through).
   */
  scriptSchemaInvalid({ reason = "extra_key" } = {}) {
    const base = {
      document_type: "Schema-invalid response",
      overall_risk: "low",
      summary: "Valid JSON that nonetheless violates the AnalysisResult schema.",
      findings: [],
      missing_clauses: [],
    };
    const body =
      reason === "extra_key"
        ? { ...base, unexpected_field: "should be rejected by .strict()" }
        : reason === "wrong_enum"
          ? { ...base, overall_risk: "catastrophic" }
          : reason === "missing_field"
            ? (() => {
                // eslint-disable-next-line no-unused-vars -- dropped deliberately, to omit the required field
                const { summary, ...rest } = base;
                return rest;
              })()
            : base;
    this.#queue.push({ kind: "text", text: JSON.stringify(body) });
    return this;
  }

  /**
   * Queues a well-formed, schema-VALID response whose clause_excerpt
   * values do not appear verbatim in any real document — meant to be
   * caught by the excerpt verifier (§5.3, step 20), not by JSON/Zod
   * parsing. `excerpts` lets a caller supply text guaranteed absent from
   * whatever fixture document a specific test uses.
   */
  scriptFabricatedExcerpts(excerpts = ["This exact sentence appears nowhere in the source document."]) {
    const body = {
      document_type: "Fabricated-excerpt response",
      overall_risk: "high",
      summary: "A response whose excerpts do not exist in the source document.",
      findings: excerpts.map((excerpt) => ({
        category: "other",
        severity: "high",
        clause_excerpt: excerpt,
        explanation: "This finding cites text that was never in the document.",
        suggested_change: "N/A — this finding should be discarded by excerpt verification.",
      })),
      missing_clauses: [],
    };
    this.#queue.push({ kind: "text", text: JSON.stringify(body) });
    return this;
  }

  /**
   * Queues a timeout. Rejects with APIUserAbortError — what
   * @anthropic-ai/sdk throws when a request is aborted via its signal,
   * which is how client.js implements the 60 s timeout (FR-3.6). Instant
   * by default so tests stay fast; pass `realDelayMs` only for a test
   * that specifically needs to measure timing.
   */
  scriptTimeout({ realDelayMs = 0 } = {}) {
    this.#queue.push({ kind: "error", build: () => new APIUserAbortError(), delayMs: realDelayMs });
    return this;
  }

  /**
   * Queues a provider HTTP error — 429 (rate limited), 529 (overloaded),
   * 401 (bad key) are FR-3.10/FR-3.11's named cases, but any status
   * works. Built via the SDK's own `APIError.generate`, the exact
   * factory @anthropic-ai/sdk uses internally to pick the right error
   * class (RateLimitError for 429, InternalServerError for >=500,
   * AuthenticationError for 401, ...) — so this produces a byte-for-byte
   * real error shape, not an approximation.
   */
  /**
   * @param {number} status
   * @param {{ message?: string, errorType?: string }} [options]
   */
  scriptHttpError(status, { message, errorType } = {}) {
    const headers = new Headers();
    const body = { type: "error", error: { type: errorType ?? "mock_error", message: message ?? `mock ${status}` } };
    this.#queue.push({
      kind: "error",
      build: () => APIError.generate(status, body, message, headers),
    });
    return this;
  }

  /**
   * Runs the next queued script, or a default valid response if nothing
   * is queued — so a test that doesn't care about LLM behavior specifically
   * (e.g. testing auth or quota wiring on the analyze route) doesn't have
   * to script one.
   */
  /** @param {{ documentText?: string, requestId?: string }} [options] */
  async analyze({ documentText, requestId } = {}) {
    const startedAt = Date.now();
    this.calls.push({ documentText, requestId, at: startedAt });

    const script = this.#queue.shift();

    if (script?.kind === "error") {
      if (script.delayMs) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
      throw script.build();
    }

    const text = script?.kind === "text" ? script.text : JSON.stringify(MockLlmProvider.#validResponseBody());

    return {
      rawText: text,
      inputTokens: 500,
      outputTokens: 150,
      model: "claude-haiku-4-5",
      durationMs: Date.now() - startedAt,
      providerRequestId: `req_mock_${randomUUID()}`,
    };
  }

  /** Empties any unconsumed scripts — call between tests that share one instance. */
  reset() {
    this.#queue = [];
    this.calls = [];
  }
}
