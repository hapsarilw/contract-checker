import { APIConnectionTimeoutError, APIUserAbortError } from "@anthropic-ai/sdk";
import config from "../../config.js";
import { AppError } from "../../lib/AppError.js";
import { createAnthropicProvider } from "./client.js";
import { MockLlmProvider } from "./mockProvider.js";
import { assertCircuitClosed, recordProviderCall } from "./circuitBreaker.js";
import { withProviderRetries } from "./retry.js";
import { buildMessageParams } from "./client.js";
import { llmRequestTotal } from "../../observability/metrics.js";
import { withSpan } from "../../observability/tracing.js";

/**
 * llm_request_total's http_status (§6.6): the provider's status when it
 * answered, "timeout" when our own deadline or the SDK's cut the call
 * off, and "network" when there was no answer at all.
 *
 * @param {"success" | "failure"} outcome
 * @param {unknown} [err]
 */
export function httpStatusLabel(outcome, err) {
  if (outcome === "success") return "200";
  if (err instanceof APIUserAbortError || err instanceof APIConnectionTimeoutError)
    return "timeout";
  const status = /** @type {{ status?: unknown }} */ (err)?.status;
  return typeof status === "number" ? String(status) : "network";
}

/**
 * FR-3.6: a timeout is LLM_TIMEOUT (504). Two SDK shapes mean timeout:
 * APIUserAbortError, thrown when client.js's AbortController fires (and what
 * the mock scripts), and APIConnectionTimeoutError, the SDK's own timeout.
 *
 * Every other provider error passes through unchanged. Mapping them —
 * retries and LLM_UNAVAILABLE for transient failures, INTERNAL plus an alert
 * for a bad key — is FR-3.10 and FR-3.11; until then a raw error still
 * reaches the user only as errorHandler's generic 500.
 *
 * @param {unknown} err
 */
export function translateProviderError(err) {
  if (err instanceof APIUserAbortError || err instanceof APIConnectionTimeoutError) {
    return new AppError("LLM_TIMEOUT", { details: { providerError: err.name } });
  }
  return err;
}

/**
 * §2.3 — LLM_PROVIDER selects the backend, and callers see one interface
 * either way. `backend` is exposed so tests can script the mock.
 *
 * THE THREE RESILIENCE LAYERS OF STEP 47 COMPOSE HERE, above the backend
 * rather than inside it, so they apply identically to the real client and
 * to the scripted mock — which is what lets TR-17 exercise a 529 storm
 * and an open breaker without touching the network.
 *
 *   assertCircuitClosed   FR-3.12, outermost: an open breaker must
 *                         short-circuit BEFORE the retry loop, or an
 *                         outage would still cost three attempts per
 *                         request, which is the queueing the breaker
 *                         exists to prevent.
 *   withProviderRetries   FR-3.10 / FR-3.11.
 *   backend.analyze       the call itself, with its own 60 s timeout.
 *
 * Every ATTEMPT is recorded into the breaker, not every analysis: FR-3.12
 * counts calls, and a retried analysis makes up to three of them.
 * Counting analyses would need three times the outage to trip.
 *
 * @param {Parameters<typeof createAnthropicProvider>[0] & { LLM_PROVIDER: "anthropic" | "mock", MOCK_LLM_DELAY_MS?: number, MOCK_LLM_FINDINGS?: "none" | "quote-document", MOCK_LLM_OUTAGE_FILE?: string }} cfg
 * @param {Parameters<typeof createAnthropicProvider>[1] & {
 *   breaker?: {
 *     assertClosed: () => Promise<void>,
 *     record: (outcome: "success" | "failure") => Promise<void> | void,
 *   },
 * }} [deps]
 */
export function createLlmProvider(cfg, deps = {}) {
  // The breaker is injectable for the same reason the SDK client is: a
  // test of the retry layer should be able to hold the breaker still,
  // and a unit test (§10: no network) should not reach Redis at all.
  // Without this the breaker's own fail-open path would quietly stand in
  // for a closed circuit, and the test would pass while asserting
  // something it had not exercised.
  const {
    breaker = { assertClosed: assertCircuitClosed, record: recordProviderCall },
    ...backendDeps
  } = deps;
  const backend =
    cfg.LLM_PROVIDER === "mock"
      ? new MockLlmProvider({
          defaultDelayMs: cfg.MOCK_LLM_DELAY_MS ?? 0,
          defaultFindings: cfg.MOCK_LLM_FINDINGS ?? "none",
          outageFile: cfg.MOCK_LLM_OUTAGE_FILE,
        })
      : createAnthropicProvider(cfg, backendDeps);
  return {
    backend,
    /**
     * @param {Parameters<ReturnType<typeof createAnthropicProvider>["analyze"]>[0]
     *   & { deadlineAt?: number }} request
     */
    async analyze(request) {
      await breaker.assertClosed();
      const { deadlineAt, ...call } = request;
      // §6.6's prompt stage. Built once, here, and handed to the backend,
      // so the stage is traced whichever backend runs (the mock ignores
      // it) and the real client does not build it a second time.
      const params = await withSpan("analysis.prompt", () =>
        buildMessageParams({
          profile: cfg.llmParamProfile,
          documentText: call.documentText,
          correction: call.correction,
        }),
      );
      return withSpan("analysis.provider_call", async (span) => {
        let attempts = 0;
        try {
          return await withProviderRetries(() => backend.analyze({ ...call, params }), {
            // Without a caller-supplied deadline the operation is bounded
            // by the analyze ceiling alone. analysis.js always supplies one;
            // this default keeps a direct caller from getting an unbounded
            // retry loop.
            deadlineAt: deadlineAt ?? Date.now() + cfg.timeouts.analyzeCeiling,
            onAttempt: (outcome, err) => {
              attempts += 1;
              llmRequestTotal.inc({
                outcome,
                http_status: httpStatusLabel(outcome, err),
              });
              return breaker.record(outcome);
            },
          });
        } catch (err) {
          throw translateProviderError(err);
        } finally {
          span.setAttribute("llm.attempts", attempts);
        }
      });
    },
  };
}

/** @type {ReturnType<typeof createLlmProvider> | undefined} */
let provider;

/** The process-wide provider, created on first use rather than at import. */
export function getLlmProvider() {
  provider ??= createLlmProvider(config);
  return provider;
}
