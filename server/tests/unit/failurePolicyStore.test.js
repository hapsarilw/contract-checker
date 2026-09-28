import { describe, it, expect, vi } from "vitest";
import { FailurePolicyStore } from "../../src/lib/failurePolicyStore.js";
import { AppError } from "../../src/lib/AppError.js";
import { reconnectDelayMs } from "../../src/lib/redis.js";

/**
 * FR-5.6 — "Where Redis is unavailable, limiters shall fail closed for
 * analysis (returning 503 SERVER_BUSY) and fail open for read paths."
 *
 * The asymmetry is the requirement, and it is pure logic, so it is tested
 * here rather than by taking a real Redis away. The integration suite
 * proves the same asymmetry end to end on the real routes; this file
 * proves the decision itself, including the cases an outage is unlikely to
 * hand you on demand.
 *
 * Importing lib/redis.js is safe in a unit test on purpose: getRedis()
 * builds its client on first use, and nothing here calls it.
 */

/** A store that behaves, so the decorator's pass-through can be checked. */
const workingStore = (info = { totalHits: 3, resetTime: new Date(1_000) }) => ({
  init: vi.fn(),
  increment: vi.fn().mockResolvedValue(info),
  decrement: vi.fn().mockResolvedValue(undefined),
  resetKey: vi.fn().mockResolvedValue(undefined),
  resetAll: vi.fn().mockResolvedValue(undefined),
});

/** A store standing in for an unreachable Redis. */
const brokenStore = (err = new Error("Connection is closed.")) => ({
  init: vi.fn(),
  increment: vi.fn().mockRejectedValue(err),
  decrement: vi.fn().mockRejectedValue(err),
  resetKey: vi.fn().mockRejectedValue(err),
  resetAll: vi.fn().mockRejectedValue(err),
});

describe("FailurePolicyStore — when the store works", () => {
  it.each(/** @type {const} */ (["open", "closed"]))(
    "passes %s-policy results through untouched",
    async (policy) => {
      const inner = workingStore();
      const store = new FailurePolicyStore({ store: inner, policy });

      await expect(store.increment("k")).resolves.toEqual({
        totalHits: 3,
        resetTime: new Date(1_000),
      });
      expect(inner.increment).toHaveBeenCalledWith("k");
    },
  );

  it("forwards init to the wrapped store, so the real one is configured", () => {
    const inner = workingStore();
    new FailurePolicyStore({ store: inner, policy: "open" }).init({ windowMs: 1_000 });
    expect(inner.init).toHaveBeenCalledWith({ windowMs: 1_000 });
  });

  it("never reports a failure when there was none", async () => {
    const onFailure = vi.fn();
    const store = new FailurePolicyStore({
      store: workingStore(),
      policy: "closed",
      onFailure,
    });
    await store.increment("k");
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe("FailurePolicyStore — fail CLOSED (the analyze path)", () => {
  it("refuses the request with 503 SERVER_BUSY, not a 429", async () => {
    const store = new FailurePolicyStore({ store: brokenStore(), policy: "closed" });

    const err = await store.increment("user:a").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("SERVER_BUSY");
    // A 429 would tell the client it exceeded a limit. It did not — the
    // server cannot tell, and says so with a 5xx.
    expect(err.status).toBe(503);
    expect(err.status).not.toBe(429);
  });

  it("carries Retry-After, so the refusal states when to come back", async () => {
    const store = new FailurePolicyStore({ store: brokenStore(), policy: "closed" });
    const err = await store.increment("user:a").catch((e) => e);
    expect(err.retryAfter).toBeGreaterThan(0);
  });

  it("reports the failure with the policy that produced it", async () => {
    const onFailure = vi.fn();
    const cause = new Error("ECONNREFUSED");
    const store = new FailurePolicyStore({
      store: brokenStore(cause),
      policy: "closed",
      onFailure,
    });

    await store.increment("user:a").catch(() => {});
    expect(onFailure).toHaveBeenCalledWith(cause, "closed");
  });
});

describe("FailurePolicyStore — fail OPEN (read paths and auth)", () => {
  it("lets the request through instead of throwing", async () => {
    const store = new FailurePolicyStore({ store: brokenStore(), policy: "open" });
    await expect(store.increment("1.2.3.4")).resolves.toBeDefined();
  });

  it("reports a positive hit count, which express-rate-limit requires", async () => {
    // A store returning 0 trips express-rate-limit's own validation. 1 is
    // also the honest number: this request happened, it just was not
    // recorded anywhere.
    const store = new FailurePolicyStore({ store: brokenStore(), policy: "open" });
    const { totalHits } = await store.increment("1.2.3.4");
    expect(totalHits).toBe(1);
    expect(Number.isInteger(totalHits) && totalHits > 0).toBe(true);
  });

  it("reports a resetTime built from the limiter's real window, not a guess", async () => {
    const store = new FailurePolicyStore({ store: brokenStore(), policy: "open" });
    store.init({ windowMs: 900_000 });

    const before = Date.now();
    const { resetTime } = await store.increment("1.2.3.4");
    const delta = /** @type {Date} */ (resetTime).getTime() - before;

    expect(delta).toBeGreaterThanOrEqual(900_000 - 1_000);
    expect(delta).toBeLessThanOrEqual(900_000 + 1_000);
  });

  it("stays open for every request, never sliding shut under sustained failure", async () => {
    // The failure mode this guards: a decorator that counts its own
    // failures and starts refusing would turn a read outage into the
    // analyze outage FR-5.6 deliberately kept separate.
    const store = new FailurePolicyStore({ store: brokenStore(), policy: "open" });
    for (let i = 0; i < 50; i++) {
      await expect(store.increment("1.2.3.4")).resolves.toMatchObject({ totalHits: 1 });
    }
  });
});

describe("FailurePolicyStore — the bookkeeping methods", () => {
  it.each(/** @type {const} */ (["open", "closed"]))(
    "swallows a failing decrement under the %s policy, so a served request is not retroactively failed",
    async (policy) => {
      const store = new FailurePolicyStore({ store: brokenStore(), policy });
      await expect(store.decrement("k")).resolves.toBeUndefined();
    },
  );

  it.each(/** @type {const} */ (["open", "closed"]))(
    "swallows a failing resetKey under the %s policy",
    async (policy) => {
      const store = new FailurePolicyStore({ store: brokenStore(), policy });
      await expect(store.resetKey("k")).resolves.toBeUndefined();
    },
  );

  it("does NOT swallow a failing resetAll — a test that silently fails to reset is worse", async () => {
    const store = new FailurePolicyStore({ store: brokenStore(), policy: "open" });
    await expect(store.resetAll()).rejects.toThrow();
  });

  it("tolerates an inner store that implements no resetAll at all", async () => {
    const minimal = { increment: vi.fn(), decrement: vi.fn(), resetKey: vi.fn() };
    const store = new FailurePolicyStore({ store: minimal, policy: "open" });
    await expect(store.resetAll()).resolves.toBeUndefined();
  });
});

describe("reconnectDelayMs (NFR-3.7's companion: how a client comes back)", () => {
  it("backs off as attempts accumulate", () => {
    expect(reconnectDelayMs(1)).toBeLessThan(reconnectDelayMs(5));
  });

  it("caps, so a long outage settles into steady retries rather than effectively never", () => {
    expect(reconnectDelayMs(1_000)).toBeLessThanOrEqual(2_100);
  });

  it("is jittered, so a restarting fleet does not reconnect in lockstep", () => {
    const delays = new Set(Array.from({ length: 40 }, () => reconnectDelayMs(50)));
    expect(delays.size).toBeGreaterThan(1);
  });
});
