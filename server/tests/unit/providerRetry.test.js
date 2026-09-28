import { describe, it, expect, vi } from "vitest";
import {
  APIError,
  APIUserAbortError,
  APIConnectionTimeoutError,
} from "@anthropic-ai/sdk";
import { AppError } from "../../src/lib/AppError.js";
import {
  classify,
  backoffMs,
  retryAfterOf,
  withProviderRetries,
  MAX_RETRIES,
} from "../../src/services/llm/retry.js";

/**
 * FR-3.10 and FR-3.11 as pure logic. The parts that need Redis or a
 * provider are in tests/integration/providerResilience.test.js (TR-17);
 * these are the decisions themselves — which errors are transient, how
 * long to wait, and when the ceiling forbids waiting at all.
 */

/** @param {number} status @param {Record<string,string>} [headers] */
const apiError = (status, headers = {}) =>
  APIError.generate(
    status,
    { type: "error", error: { type: "x", message: "m" } },
    "m",
    new Headers(headers),
  );

const never = async () => {
  throw new Error("should not have been called");
};

describe("classify (FR-3.10's transient set, FR-3.11's configuration set)", () => {
  it.each([429, 500, 502, 503, 529])("treats %i as retryable", (status) => {
    expect(classify(apiError(status))).toBe("retryable");
  });

  it.each([400, 401, 403, 404])(
    "treats %i as a configuration defect, never retryable",
    (status) => {
      expect(classify(apiError(status))).toBe("config");
    },
  );

  it.each(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"])(
    "treats a %s connection failure as retryable — the call never got an answer",
    (code) => {
      expect(classify(Object.assign(new Error("socket"), { code }))).toBe("retryable");
    },
  );

  it("does not retry our own timeout", () => {
    // Retrying would spend another 60 seconds of a 90-second budget on
    // the same request. llm/index.js maps this to LLM_TIMEOUT instead.
    expect(classify(new APIUserAbortError())).toBe("timeout");
    expect(classify(new APIConnectionTimeoutError())).toBe("timeout");
  });

  it("does not retry a status the spec names neither way", () => {
    // Spending a retry budget on an error nobody predicted is how a
    // defect turns into an outage.
    expect(classify(apiError(418))).toBe("other");
    expect(classify(new Error("something else"))).toBe("other");
  });
});

describe("backoffMs (exponential, FULL jitter, base 1 s, cap 8 s)", () => {
  it("grows exponentially in its ceiling", () => {
    const atMax = (attempt) => backoffMs(attempt, null, () => 0.999999);
    expect(atMax(0)).toBeLessThanOrEqual(1_000);
    expect(atMax(1)).toBeLessThanOrEqual(2_000);
    expect(atMax(2)).toBeLessThanOrEqual(4_000);
    expect(atMax(1)).toBeGreaterThan(atMax(0));
  });

  it("caps at 8 s however many attempts have passed", () => {
    expect(backoffMs(20, null, () => 0.999999)).toBeLessThanOrEqual(8_000);
  });

  it("is FULL jitter: the delay ranges over the whole interval, not a wobble", () => {
    // Full jitter is what spreads a recovering fleet. A narrow band around
    // the backoff would let every instance retry together and re-break the
    // provider that just came back.
    expect(backoffMs(3, null, () => 0)).toBe(0);
    expect(backoffMs(3, null, () => 0.999999)).toBeGreaterThan(7_000);
  });

  it("honours Retry-After over its own guess — the provider knows better", () => {
    expect(backoffMs(0, 5, () => 0.5)).toBe(5_000);
  });

  it("still caps a Retry-After, so a hostile or absurd value cannot park the request", () => {
    expect(backoffMs(0, 3_600, () => 0.5)).toBe(8_000);
  });

  it("ignores a Retry-After that is not a usable number", () => {
    expect(retryAfterOf(apiError(429, { "retry-after": "soon" }))).toBeNull();
    expect(retryAfterOf(apiError(429, { "retry-after": "3" }))).toBe(3);
    expect(retryAfterOf(apiError(429))).toBeNull();
  });
});

describe("withProviderRetries", () => {
  const far = () => Date.now() + 90_000;

  it("returns the first success without waiting", async () => {
    const attempt = vi.fn().mockResolvedValue("ok");
    const sleep = vi.fn();
    await expect(
      withProviderRetries(attempt, { deadlineAt: far(), sleep }),
    ).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a transient failure and returns the eventual success", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(apiError(529)).mockResolvedValue("ok");
    await expect(
      withProviderRetries(attempt, { deadlineAt: far(), sleep: async () => {} }),
    ).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("gives up after exactly two retries with LLM_UNAVAILABLE (FR-3.10)", async () => {
    const attempt = vi.fn().mockRejectedValue(apiError(529));
    const err = await withProviderRetries(attempt, {
      deadlineAt: far(),
      sleep: async () => {},
    }).catch((e) => e);

    expect(attempt).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("LLM_UNAVAILABLE");
    expect(err.status).toBe(503);
    expect(err.retryAfter).toBeGreaterThan(0);
  });

  it("never retries a 401, and maps it to INTERNAL (FR-3.11)", async () => {
    // A bad key is a configuration defect: no amount of waiting fixes it,
    // and telling the user to try again in a minute would be a lie.
    const attempt = vi.fn().mockRejectedValue(apiError(401));
    const err = await withProviderRetries(attempt, {
      deadlineAt: far(),
      sleep: async () => {},
    }).catch((e) => e);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(err.code).toBe("INTERNAL");
    expect(err.status).toBe(500);
  });

  it("passes a non-retryable, non-config error through untouched", async () => {
    const cause = apiError(418);
    const attempt = vi.fn().mockRejectedValue(cause);
    await expect(
      withProviderRetries(attempt, { deadlineAt: far(), sleep: async () => {} }),
    ).rejects.toBe(cause);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("refuses to start a wait it cannot finish inside the ceiling", async () => {
    // The 90-second ceiling, enforced as a deadline. Sleeping anyway would
    // burn the remaining budget and fail afterwards regardless.
    const attempt = vi.fn().mockRejectedValue(apiError(503, { "retry-after": "8" }));
    const sleep = vi.fn();
    const err = await withProviderRetries(attempt, {
      deadlineAt: Date.now() + 500,
      sleep,
    }).catch((e) => e);

    expect(sleep).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(err.code).toBe("LLM_UNAVAILABLE");
  });

  it("reports every attempt to the breaker, successes and failures alike", async () => {
    // FR-3.12 counts CALLS. A retried analysis is three of them, and
    // counting analyses instead would need three times the outage to trip.
    const onAttempt = vi.fn();
    const attempt = vi.fn().mockRejectedValueOnce(apiError(529)).mockResolvedValue("ok");

    await withProviderRetries(attempt, {
      deadlineAt: far(),
      sleep: async () => {},
      onAttempt,
    });

    expect(onAttempt.mock.calls.map(([outcome]) => outcome)).toEqual([
      "failure",
      "success",
    ]);
  });

  it("reports the failed attempt even when it will not be retried", async () => {
    const onAttempt = vi.fn();
    await withProviderRetries(never, {
      deadlineAt: far(),
      sleep: async () => {},
      onAttempt,
    }).catch(() => {});
    // The error travels with it since step 67, for llm_request_total's
    // http_status label.
    expect(onAttempt).toHaveBeenCalledWith("failure", expect.any(Error));
  });
});
