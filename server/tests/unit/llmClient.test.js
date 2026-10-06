import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic, {
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { MODEL_PARAM_PROFILES, parseConfig } from "../../src/config.js";
import {
  MAX_TOKENS,
  buildClientOptions,
  buildMessageParams,
  createAnthropicProvider,
} from "../../src/services/llm/client.js";
import {
  createLlmProvider,
  getLlmProvider,
  translateProviderError,
} from "../../src/services/llm/index.js";
import { MockLlmProvider } from "../../src/services/llm/mockProvider.js";
import { AppError } from "../../src/lib/AppError.js";
import logger from "../../src/observability/logger.js";
import {
  SYSTEM_PROMPT,
  retryCorrection,
  userMessage,
} from "../../src/prompts/analyze.js";

/**
 * SRS §5.4, FR-3.5, FR-3.6, §2.3 — the provider client, provider selection,
 * and the timeout translation both providers share.
 */
const SRS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "SRS.md"),
  "utf8",
);

/** §5.4's capability table, read from the spec: one entry per listed model. */
function specCapabilityTable() {
  const section = SRS.slice(
    SRS.indexOf("### 5.4 LLM call parameters"),
    SRS.indexOf("### 5.5 Migration policy"),
  );
  const rows = section.split("\n").filter((line) => line.startsWith("| `claude-"));
  if (rows.length === 0) throw new Error("docs/SRS.md §5.4: capability table not found");
  return rows.flatMap((row) => {
    const [models, temperature, effort] = row
      .split("|")
      .slice(1, 4)
      .map((cell) => cell.trim());
    if (
      !/^(accepted|rejected)/.test(temperature) ||
      !/^(supported|rejected)/.test(effort)
    ) {
      throw new Error(`docs/SRS.md §5.4: unrecognised capability row: ${row}`);
    }
    return [...models.matchAll(/`([^`]+)`/g)].map((match) => ({
      model: match[1],
      temperature: temperature.startsWith("accepted"),
      effort: effort.startsWith("supported"),
    }));
  });
}

/** A valid environment for parseConfig, without reading process.env. */
function env(overrides = {}) {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://test:test@localhost:5432/clausecheck_test",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    ANTHROPIC_MODEL: "claude-haiku-4-5",
    JWT_SECRET: "test-jwt-secret-at-least-32-bytes-long-ok",
    FRONTEND_ORIGIN: "http://localhost:5173",
    // Required since step 44. This fixture builds a whole environment
    // from scratch, so it has to carry every required variable.
    REDIS_URL: "redis://localhost:6379",
    AUDIT_SALT: "test-audit-salt-at-least-32-bytes-long-ok",
    LLM_PRICE_INPUT_PER_MTOK: "2",
    LLM_PRICE_OUTPUT_PER_MTOK: "10",
    MONTHLY_SPEND_CEILING_USD: "100",
    ...overrides,
  };
}

/**
 * A breaker that is always closed and records nothing. §10 defines a unit
 * test as one with no network; the real breaker reads Redis, and its own
 * fail-open path would otherwise stand in for a closed circuit here,
 * letting these tests pass while asserting something they never ran.
 */
const CLOSED_BREAKER = { assertClosed: async () => {}, record: () => {} };

const DOCUMENT = "CONSULTING AGREEMENT\n\nThe Client shall pay within ninety (90) days.";

/**
 * Shaped like an SDK Message; `_request_id` is non-enumerable, as the SDK makes it.
 *
 * @param {{ content?: object[], requestId?: string | null }} [options]
 */
function providerMessage({ content, requestId = "req_011CTest" } = {}) {
  const message = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: content ?? [{ type: "text", text: '{"ok":true}' }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1234, output_tokens: 567 },
  };
  if (requestId !== null) {
    Object.defineProperty(message, "_request_id", {
      value: requestId,
      enumerable: false,
    });
  }
  return message;
}

/**
 * A stand-in for the SDK client that records each create() call.
 *
 * @param {(params: any, options: any) => Promise<unknown>} [respond]
 */
function fakeAnthropic(respond = () => Promise.resolve(providerMessage())) {
  const calls = [];
  const client = {
    calls,
    messages: {
      create: (params, options) => {
        calls.push({ params, options });
        return respond(params, options);
      },
    },
  };
  return /** @type {any} */ (client);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("§5.4's capability table, config.js's profiles, and the request body", () => {
  const table = specCapabilityTable();

  it("config.js profiles exactly the models §5.4 lists, with the same capabilities", () => {
    const fromSpec = Object.fromEntries(
      table.map(({ model, temperature, effort }) => [model, { temperature, effort }]),
    );
    expect(Object.keys(MODEL_PARAM_PROFILES).sort()).toEqual(
      Object.keys(fromSpec).sort(),
    );
    for (const [model, profile] of Object.entries(MODEL_PARAM_PROFILES)) {
      expect({ ...profile }, model).toEqual(fromSpec[model]);
    }
  });

  it.each(table)(
    "$model: temperature only if accepted ($temperature), effort only if supported ($effort)",
    ({ model, temperature, effort }) => {
      const { llmParamProfile } = parseConfig(env({ ANTHROPIC_MODEL: model }));
      const params = buildMessageParams({
        profile: llmParamProfile,
        documentText: DOCUMENT,
      });

      expect(params.model).toBe(model);
      expect(params.max_tokens).toBe(4096);
      expect(MAX_TOKENS).toBe(4096);
      expect("temperature" in params).toBe(temperature);
      if (temperature) expect(params.temperature).toBe(0);
      expect("output_config" in params).toBe(effort);
      if (effort) expect(params.output_config).toEqual({ effort: "low" });
      expect(params).not.toHaveProperty("top_p");
      expect(params).not.toHaveProperty("top_k");
      expect(params).not.toHaveProperty("stream");
    },
  );

  it("rejects an unprofiled model at config parse, naming it", () => {
    expect(() => parseConfig(env({ ANTHROPIC_MODEL: "claude-3-opus-20240229" }))).toThrow(
      /claude-3-opus-20240229/,
    );
  });
});

describe("the request (Appendix A, NFR-2.8)", () => {
  const profile = parseConfig(env()).llmParamProfile;

  it("puts Appendix A's system prompt in system and the document only in the user message", () => {
    const params = buildMessageParams({ profile, documentText: DOCUMENT });
    expect(params.system).toBe(SYSTEM_PROMPT);
    expect(params.messages).toEqual([{ role: "user", content: userMessage(DOCUMENT) }]);
    expect(params.system).not.toContain(DOCUMENT);
  });

  it("appends the retry correction to the same conversation, after the invalid response", () => {
    const correction = {
      invalidResponse: "Here is my analysis.",
      errorSummary: "not valid JSON",
    };
    const params = buildMessageParams({ profile, documentText: DOCUMENT, correction });
    expect(params.messages).toEqual([
      { role: "user", content: userMessage(DOCUMENT) },
      { role: "assistant", content: "Here is my analysis." },
      { role: "user", content: retryCorrection("not valid JSON") },
    ]);
  });

  it("leaves out an empty invalid response, which the API would reject as an assistant turn", () => {
    const correction = { invalidResponse: "  \n", errorSummary: "not valid JSON" };
    const params = buildMessageParams({ profile, documentText: DOCUMENT, correction });
    expect(params.messages.map((message) => message.role)).toEqual(["user", "user"]);
  });
});

describe("inference geography (step 75, ANTHROPIC_INFERENCE_GEO)", () => {
  it("sends inference_geo only when one is configured; unset leaves the workspace default", () => {
    for (const geo of /** @type {const} */ (["us", "global"])) {
      const { llmParamProfile } = parseConfig(env({ ANTHROPIC_INFERENCE_GEO: geo }));
      expect(
        buildMessageParams({ profile: llmParamProfile, documentText: DOCUMENT })
          .inference_geo,
      ).toBe(geo);
    }
    for (const unset of [{}, { ANTHROPIC_INFERENCE_GEO: "" }]) {
      const { llmParamProfile } = parseConfig(env(unset));
      expect(
        buildMessageParams({ profile: llmParamProfile, documentText: DOCUMENT }),
      ).not.toHaveProperty("inference_geo");
    }
  });

  it("refuses a geography the API does not offer", () => {
    expect(() => parseConfig(env({ ANTHROPIC_INFERENCE_GEO: "eu" }))).toThrow();
  });

  it("logs an error when the provider says inference ran somewhere else than asked", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const message = providerMessage();
    message.usage = { ...message.usage, inference_geo: "global" };
    const cfg = parseConfig(
      env({ LLM_PROVIDER: "anthropic", ANTHROPIC_INFERENCE_GEO: "us" }),
    );
    const provider = createAnthropicProvider(cfg, {
      anthropic: fakeAnthropic(() => Promise.resolve(message)),
    });
    await provider.analyze({ documentText: DOCUMENT });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        alert: "inference_geo_mismatch",
        asked: "us",
        ranIn: "global",
      }),
      expect.any(String),
    );
    error.mockRestore();
  });

  it("is quiet when inference ran where it was asked to, or nothing was asked", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const here = providerMessage();
    here.usage = { ...here.usage, inference_geo: "us" };
    const asked = parseConfig(
      env({ LLM_PROVIDER: "anthropic", ANTHROPIC_INFERENCE_GEO: "us" }),
    );
    await createAnthropicProvider(asked, {
      anthropic: fakeAnthropic(() => Promise.resolve(here)),
    }).analyze({
      documentText: DOCUMENT,
    });
    const unasked = parseConfig(env({ LLM_PROVIDER: "anthropic" }));
    await createAnthropicProvider(unasked, {
      anthropic: fakeAnthropic(() => Promise.resolve(here)),
    }).analyze({
      documentText: DOCUMENT,
    });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("the client (§5.4, FR-3.5, FR-3.6)", () => {
  const cfg = parseConfig(env());

  it("disables SDK retries: maxRetries is 0 in the options and on the constructed client", () => {
    expect(buildClientOptions(cfg)).toEqual({ apiKey: "sk-ant-test-key", maxRetries: 0 });
    expect(new Anthropic(buildClientOptions(cfg)).maxRetries).toBe(0);
  });

  it("returns the text and exactly the instrumentation fields FR-3.5 needs", async () => {
    const anthropic = fakeAnthropic(() =>
      Promise.resolve(
        providerMessage({
          content: [
            {
              type: "thinking",
              thinking: "Reading the payment clause first.",
              signature: "sig",
            },
            { type: "text", text: '{"document_type":' },
            { type: "text", text: '"x"}' },
          ],
        }),
      ),
    );
    const result = await createAnthropicProvider(cfg, { anthropic }).analyze({
      documentText: DOCUMENT,
    });

    expect(Object.keys(result).sort()).toEqual([
      "durationMs",
      "inputTokens",
      "model",
      "outputTokens",
      "providerRequestId",
      "rawText",
    ]);
    expect(result.rawText).toBe('{"document_type":"x"}');
    expect(result.inputTokens).toBe(1234);
    expect(result.outputTokens).toBe(567);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.providerRequestId).toBe("req_011CTest");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a missing provider request id as null", async () => {
    const anthropic = fakeAnthropic(() =>
      Promise.resolve(providerMessage({ requestId: null })),
    );
    const result = await createAnthropicProvider(cfg, { anthropic }).analyze({
      documentText: DOCUMENT,
    });
    expect(result.providerRequestId).toBeNull();
  });

  it("sends the built request, an abort signal, and this request's correlation id", async () => {
    const anthropic = fakeAnthropic();
    await createAnthropicProvider(cfg, { anthropic }).analyze({
      documentText: DOCUMENT,
      requestId: "01J9F2REQUEST",
    });

    const [{ params, options }] = anthropic.calls;
    expect(params).toEqual(
      buildMessageParams({ profile: cfg.llmParamProfile, documentText: DOCUMENT }),
    );
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers).toEqual({ "X-Request-Id": "01J9F2REQUEST" });
  });

  it("sends no correlation header when there is no request id", async () => {
    const anthropic = fakeAnthropic();
    await createAnthropicProvider(cfg, { anthropic }).analyze({ documentText: DOCUMENT });
    expect(anthropic.calls[0].options).not.toHaveProperty("headers");
  });

  it("aborts the provider call when the timeout elapses, and that becomes LLM_TIMEOUT (504)", async () => {
    // Behaves like the SDK: rejects with APIUserAbortError when its signal
    // aborts, and otherwise answers after 200 ms — so a client that never
    // passed the signal would get an answer, and this test would fail.
    const anthropic = fakeAnthropic(
      (_params, options) =>
        new Promise((resolve, reject) => {
          const answer = setTimeout(() => resolve(providerMessage()), 200);
          options.signal.addEventListener("abort", () => {
            clearTimeout(answer);
            reject(new APIUserAbortError());
          });
        }),
    );
    const shortTimeout = { ...cfg, timeouts: { ...cfg.timeouts, llm: 20 } };
    const provider = createLlmProvider(
      { ...shortTimeout, LLM_PROVIDER: "anthropic" },
      { anthropic },
    );

    const err = await provider
      .analyze({ documentText: DOCUMENT })
      .catch((error) => error);

    expect(anthropic.calls[0].options.signal.aborted).toBe(true);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("LLM_TIMEOUT");
    expect(err.status).toBe(504);
  });

  it("uses the configured LLM timeout (60 s by default) and clears it once the call returns", async () => {
    vi.useFakeTimers();
    expect(cfg.timeouts.llm).toBe(60_000);
    const anthropic = fakeAnthropic();
    await createAnthropicProvider(cfg, { anthropic }).analyze({ documentText: DOCUMENT });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("provider selection and error translation (§2.3, FR-3.6)", () => {
  const cfg = parseConfig(env());

  it("selects the mock for LLM_PROVIDER=mock and the SDK client otherwise", () => {
    expect(
      createLlmProvider({ ...cfg, LLM_PROVIDER: "mock" }, { breaker: CLOSED_BREAKER })
        .backend,
    ).toBeInstanceOf(MockLlmProvider);
    expect(
      createLlmProvider(
        { ...cfg, LLM_PROVIDER: "anthropic" },
        { anthropic: fakeAnthropic() },
      ).backend,
    ).not.toBeInstanceOf(MockLlmProvider);
  });

  it("is the mock in the test environment, and one instance per process — CI never reaches the network", () => {
    expect(getLlmProvider().backend).toBeInstanceOf(MockLlmProvider);
    expect(getLlmProvider()).toBe(getLlmProvider());
  });

  it("returns every instrumentation field from a successful mock call", async () => {
    const result = await createLlmProvider(
      { ...cfg, LLM_PROVIDER: "mock" },
      { breaker: CLOSED_BREAKER },
    ).analyze({
      documentText: DOCUMENT,
      requestId: "r1",
    });
    expect(Object.keys(result).sort()).toEqual([
      "durationMs",
      "inputTokens",
      "model",
      "outputTokens",
      "providerRequestId",
      "rawText",
    ]);
  });

  it("turns a scripted mock timeout into LLM_TIMEOUT (504)", async () => {
    const provider = createLlmProvider(
      { ...cfg, LLM_PROVIDER: "mock" },
      { breaker: CLOSED_BREAKER },
    );
    /** @type {MockLlmProvider} */ (provider.backend).scriptTimeout();

    const err = await provider
      .analyze({ documentText: DOCUMENT })
      .catch((error) => error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("LLM_TIMEOUT");
    expect(err.status).toBe(504);
  });

  it("maps the SDK's own connection timeout to LLM_TIMEOUT as well", () => {
    const translated = translateProviderError(new APIConnectionTimeoutError());
    expect(translated).toBeInstanceOf(AppError);
    expect(/** @type {AppError} */ (translated).code).toBe("LLM_TIMEOUT");
  });

  it("retries a 429 rather than surfacing it — FR-3.10 arrived at step 47", async () => {
    // Until step 47 this asserted that a RateLimitError passed straight
    // through, "for the FR-3.10/FR-3.11 policy to handle". That policy now
    // exists, so the same input has a different and correct answer: one
    // 429 followed by a healthy response is a successful analysis.
    const provider = createLlmProvider(
      { ...cfg, LLM_PROVIDER: "mock" },
      { breaker: CLOSED_BREAKER },
    );
    /** @type {MockLlmProvider} */ (provider.backend).scriptHttpError(429);

    const result = await provider.analyze({ documentText: DOCUMENT });

    expect(result.rawText).toContain("overall_risk");
    // Two calls: the 429 and the retry that succeeded.
    expect(/** @type {MockLlmProvider} */ (provider.backend).calls).toHaveLength(2);
  });

  it("records the retry correction on the mock, so the orchestrator's retry can be asserted", async () => {
    const provider = createLlmProvider(
      { ...cfg, LLM_PROVIDER: "mock" },
      { breaker: CLOSED_BREAKER },
    );
    const correction = { invalidResponse: "{", errorSummary: "not valid JSON" };
    await provider.analyze({ documentText: DOCUMENT, requestId: "r2", correction });
    expect(/** @type {MockLlmProvider} */ (provider.backend).calls[0].correction).toEqual(
      correction,
    );
  });
});
