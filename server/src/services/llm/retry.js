import { APIError, APIUserAbortError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { AppError } from "../../lib/AppError.js";
import logger from "../../observability/logger.js";

/**
 * FR-3.10 and FR-3.11 — what to do about a provider call that fails.
 *
 * TWO BUDGETS, ONE CEILING. This retry budget is DISTINCT from FR-3.2's
 * single schema-validation retry: one is about a call that did not
 * arrive, the other about an answer that arrived malformed. They stack —
 * a schema retry can itself be retried at the transport level — and the
 * spec is explicit that they "do not compose beyond a total 90-second
 * ceiling on the analyze operation". So the ceiling is not enforced here.
 * It is a DEADLINE created once per analysis and threaded through both
 * budgets; this layer only refuses to start a wait it cannot finish
 * inside it. Enforcing 90 seconds in this module instead would give each
 * schema retry its own fresh 90 seconds, which is the composition the
 * spec forbids.
 */

/** FR-3.10: two retries, so three attempts at most. */
export const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;

/** FR-3.10's transient set. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
/** FR-3.11's configuration-defect set. */
const CONFIG_ERROR_STATUS = new Set([400, 401, 403, 404]);

/** Connection resets and their relatives: the call never got an answer. */
const RETRYABLE_SYSCALL_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

/**
 * @param {unknown} err
 * @returns {"retryable" | "config" | "timeout" | "other"}
 */
export function classify(err) {
  // A timeout is the caller's own AbortController firing (FR-3.6), not a
  // provider verdict. Retrying it would spend another 60 seconds of a
  // 90-second budget on the same request, so it is not retryable here —
  // llm/index.js maps it to LLM_TIMEOUT.
  if (err instanceof APIUserAbortError || err instanceof APIConnectionTimeoutError) return "timeout";

  if (err instanceof APIError && typeof err.status === "number") {
    if (CONFIG_ERROR_STATUS.has(err.status)) return "config";
    if (RETRYABLE_STATUS.has(err.status)) return "retryable";
    // A status the spec names neither way — a 404 is config, a 418 is
    // nobody's idea of transient. Not retried: spending a budget on an
    // error nobody predicted is how a defect becomes an outage.
    return "other";
  }

  const code = /** @type {{ code?: string }} */ (err)?.code;
  if (typeof code === "string" && RETRYABLE_SYSCALL_CODES.has(code)) return "retryable";

  return "other";
}

/**
 * Exponential backoff with FULL jitter (FR-3.10), base 1 s, cap 8 s.
 *
 * Full jitter means the delay is uniform in [0, backoff], not
 * backoff ± a wobble. The difference matters at exactly the moment a
 * breaker exists for: when a provider recovers, every instance that has
 * been waiting retries at once unless the jitter can spread them across
 * the whole interval, and a synchronised retry storm re-breaks what just
 * came back.
 *
 * `Retry-After` wins when the provider sent one — it is the provider
 * saying how long it actually needs, which beats a guess.
 *
 * @param {number} attempt zero-based
 * @param {number | null} retryAfterSeconds
 * @param {() => number} [random] injectable for tests
 */
export function backoffMs(attempt, retryAfterSeconds, random = Math.random) {
  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1_000, MAX_DELAY_MS);
  }
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.floor(random() * ceiling);
}

/** The provider's Retry-After, in seconds, when it sent one. */
export function retryAfterOf(err) {
  const headers = /** @type {{ headers?: Headers | Record<string, string> }} */ (err)?.headers;
  if (!headers) return null;
  const raw =
    typeof (/** @type {Headers} */ (headers).get) === "function"
      ? /** @type {Headers} */ (headers).get("retry-after")
      : /** @type {Record<string, string>} */ (headers)["retry-after"];
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * FR-3.11 — a configuration defect, not a runtime condition.
 *
 * Mapped to INTERNAL so the user is not told to try again in a minute for
 * something no amount of waiting fixes, and logged at error with the
 * provider request id and a stable `alert` field so the `llm_config_error`
 * rule in Appendix C has something to match. A bad API key must page
 * someone rather than silently fail every analysis, and the alert is the
 * only part of that which this layer can do.
 *
 * @param {APIError} err
 */
function configError(err) {
  logger.error(
    {
      alert: "llm_config_error",
      provider: {
        status: err.status,
        requestId: /** @type {{ request_id?: string }} */ (err).request_id ?? null,
        type: /** @type {{ error?: { error?: { type?: string } } }} */ (err)?.error?.error?.type ?? null,
      },
    },
    "FR-3.11: non-retryable provider error — this is a configuration defect, not a transient failure",
  );
  return new AppError("INTERNAL");
}

/**
 * Runs `attempt` under FR-3.10's retry policy.
 *
 * @template T
 * @param {() => Promise<T>} attempt
 * @param {{
 *   deadlineAt: number,
 *   onAttempt?: (outcome: "success" | "failure", err?: unknown) => void | Promise<void>,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 * }} options
 * @returns {Promise<T>}
 */
export async function withProviderRetries(attempt, { deadlineAt, onAttempt, sleep = defaultSleep, random }) {
  for (let tries = 0; ; tries += 1) {
    try {
      const result = await attempt();
      await onAttempt?.("success");
      return result;
    } catch (err) {
      await onAttempt?.("failure", err);

      const kind = classify(err);
      if (kind === "config") throw configError(/** @type {APIError} */ (err));
      if (kind !== "retryable") throw err;

      if (tries >= MAX_RETRIES) {
        logger.warn(
          { attempts: tries + 1, status: /** @type {APIError} */ (err).status },
          "FR-3.10: provider retry budget exhausted",
        );
        throw new AppError("LLM_UNAVAILABLE");
      }

      const delay = backoffMs(tries, retryAfterOf(err), random);

      // The 90-second ceiling, enforced as a deadline rather than a
      // stopwatch in this loop. Starting a wait we cannot finish inside
      // the budget would burn the remaining time and then fail anyway —
      // better to fail now with the honest code and let the user retry.
      if (Date.now() + delay >= deadlineAt) {
        logger.warn(
          { attempts: tries + 1, delay, status: /** @type {APIError} */ (err).status },
          "FR-3.10: analyze ceiling reached before the next retry could complete",
        );
        throw new AppError("LLM_UNAVAILABLE");
      }

      await sleep(delay);
    }
  }
}

/** @param {number} ms */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
