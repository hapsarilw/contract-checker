import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, retryCorrection, userMessage } from "../../prompts/analyze.js";

/**
 * SRS §5.4 — the real provider behind LLM_PROVIDER=anthropic (FR-3.5,
 * FR-3.6). It builds the request, calls the Messages API once, and returns
 * the response text with its instrumentation. Parsing and validation belong
 * to the orchestrator (§2.2 steps 6-7); translating errors belongs to
 * llm/index.js, so this client and the mock fail in the same shapes.
 */

/** §5.4: 25 findings at full length fit comfortably. */
export const MAX_TOKENS = 4096;

/**
 * @typedef {import("@anthropic-ai/sdk").Anthropic.MessageCreateParamsNonStreaming} MessageParams
 * @typedef {import("@anthropic-ai/sdk").Anthropic.Message & { _request_id?: string | null }} ProviderMessage
 * @typedef {{ model: string, temperature: boolean, effort: boolean }} ParamProfile
 * @typedef {{ invalidResponse: string, errorSummary: string }} Correction
 * @typedef {{ rawText: string, inputTokens: number, outputTokens: number, model: string, durationMs: number, providerRequestId: string | null }} ProviderResult
 */

/**
 * maxRetries is 0 on purpose. The SDK retries by default, and stacked under
 * FR-3.10's retry policy that multiplies latency and cost — the two
 * uncoordinated retry layers §5.4 warns about. LLM_MAX_RETRIES configures
 * that policy, never this option.
 *
 * @param {{ ANTHROPIC_API_KEY: string }} cfg
 */
export function buildClientOptions(cfg) {
  return { apiKey: cfg.ANTHROPIC_API_KEY, maxRetries: 0 };
}

/**
 * §5.4's capability table applied to one request: send only what the
 * configured model accepts. temperature is 0 where the profile allows it and
 * absent otherwise, because current models reject it with a 400; effort is
 * "low" where supported. top_p and top_k are never sent.
 *
 * The document goes only into the user message (NFR-2.8). With a
 * correction, Appendix A's retry message is appended to the same
 * conversation, after the invalid response.
 *
 * @param {{ profile: ParamProfile, documentText: string, correction?: Correction }} input
 * @returns {MessageParams}
 */
export function buildMessageParams({ profile, documentText, correction }) {
  /** @type {MessageParams["messages"]} */
  const messages = [{ role: "user", content: userMessage(documentText) }];
  if (correction) {
    // The API rejects an empty assistant turn, so an empty invalid response
    // is left out; consecutive user turns are merged into one.
    if (correction.invalidResponse.trim() !== "") {
      messages.push({ role: "assistant", content: correction.invalidResponse });
    }
    messages.push({ role: "user", content: retryCorrection(correction.errorSummary) });
  }

  /** @type {MessageParams} */
  const params = {
    model: profile.model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages,
  };
  if (profile.temperature) params.temperature = 0;
  if (profile.effort) params.output_config = { effort: "low" };
  return params;
}

/**
 * @param {{ llmParamProfile: ParamProfile, ANTHROPIC_API_KEY: string, timeouts: { llm: number } }} cfg
 * @param {{ anthropic?: { messages: { create(params: MessageParams, options: { signal: AbortSignal, headers?: Record<string, string> }): PromiseLike<ProviderMessage> } } }} [deps]
 */
export function createAnthropicProvider(
  cfg,
  { anthropic = new Anthropic(buildClientOptions(cfg)) } = {},
) {
  return {
    /**
     * FR-3.6: the whole call is bounded by an AbortController, so a timeout
     * cancels the HTTP request instead of abandoning it. The SDK then
     * rejects with APIUserAbortError, which llm/index.js maps to
     * LLM_TIMEOUT.
     *
     * @param {{ documentText: string, requestId?: string, correction?: Correction }} request
     * @returns {Promise<ProviderResult>}
     */
    async analyze({ documentText, requestId, correction }) {
      const params = buildMessageParams({
        profile: cfg.llmParamProfile,
        documentText,
        correction,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeouts.llm);
      const startedAt = Date.now();
      try {
        const response = await anthropic.messages.create(params, {
          signal: controller.signal,
          // This request's correlation id, carried on the provider call.
          ...(requestId ? { headers: { "X-Request-Id": requestId } } : {}),
        });
        return {
          // Text blocks only: models with thinking on by default (§5.4)
          // return thinking blocks ahead of the answer.
          rawText: response.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join(""),
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          // The model the provider reports serving. The model that was asked
          // for is already on the analysis row, written before the call
          // (FR-3.14).
          model: response.model,
          durationMs: Date.now() - startedAt,
          providerRequestId: response._request_id ?? null,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
