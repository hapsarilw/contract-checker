import { APIConnectionTimeoutError, APIUserAbortError } from "@anthropic-ai/sdk";
import config from "../../config.js";
import { AppError } from "../../lib/AppError.js";
import { createAnthropicProvider } from "./client.js";
import { MockLlmProvider } from "./mockProvider.js";

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
 * @param {Parameters<typeof createAnthropicProvider>[0] & { LLM_PROVIDER: "anthropic" | "mock" }} cfg
 * @param {Parameters<typeof createAnthropicProvider>[1]} [deps]
 */
export function createLlmProvider(cfg, deps) {
  const backend =
    cfg.LLM_PROVIDER === "mock"
      ? new MockLlmProvider()
      : createAnthropicProvider(cfg, deps);
  return {
    backend,
    /** @param {Parameters<ReturnType<typeof createAnthropicProvider>["analyze"]>[0]} request */
    async analyze(request) {
      try {
        return await backend.analyze(request);
      } catch (err) {
        throw translateProviderError(err);
      }
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
