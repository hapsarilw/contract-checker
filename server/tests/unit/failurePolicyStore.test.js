import { describe, it, expect, vi } from "vitest";
import { RedisStore } from "rate-limit-redis";
import {
  ANALYZE_UNAVAILABLE_MESSAGE,
  FailurePolicyStore,
  STORE_UNAVAILABLE_MESSAGE,
  STORE_UNAVAILABLE_RETRY_AFTER_SECONDS,
} from "../../src/lib/failurePolicyStore.js";
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

  it("says what is true, not SERVER_BUSY's 'at capacity, a few seconds' (step 75)", async () => {
    // The first Redis outage drill heard "at capacity" every five seconds
    // for five minutes from a server that was idle.
    const store = new FailurePolicyStore({ store: brokenStore(), policy: "closed" });
    const err = await store.increment("user:a").catch((e) => e);
    expect(err.code).toBe("SERVER_BUSY");
    expect(err.message).toBe(STORE_UNAVAILABLE_MESSAGE);
    expect(err.message).not.toMatch(/capacity|few seconds/);
    expect(err.retryAfter).toBe(STORE_UNAVAILABLE_RETRY_AFTER_SECONDS);
    expect(STORE_UNAVAILABLE_RETRY_AFTER_SECONDS).toBe(60);
  });

  it("states a limiter's own message when it has one", async () => {
    const store = new FailurePolicyStore({
      store: brokenStore(),
      policy: "closed",
      unavailableMessage: ANALYZE_UNAVAILABLE_MESSAGE,
    });
    const err = await store.increment("user:a").catch((e) => e);
    expect(err.message).toBe(ANALYZE_UNAVAILABLE_MESSAGE);
    expect(err.message).toMatch(/saved reports still open/);
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

/**
 * A Redis for the REAL rate-limit-redis store: unreachable until up(), as
 * at a boot during a Key Value restart. The refusal is the message ioredis
 * gives with maxRetriesPerRequest 1 (lib/redis.js), measured at a real boot
 * on 2026-10-06.
 */
function redisDownAtBoot() {
  let reachable = false;
  /** @type {Map<string, number>} */
  const hits = new Map();
  const sendCommand = vi.fn(async (/** @type {string[]} */ ...args) => {
    if (!reachable) {
      throw new Error("Reached the max retries per request limit (which is 1).");
    }
    if (args[0] === "SCRIPT")
      return args[2].includes("INCR") ? "sha-increment" : "sha-get";
    if (args[0] === "EVALSHA") {
      const n = (hits.get(args[3]) ?? 0) + 1;
      hits.set(args[3], n);
      return [n, Number(args[4])];
    }
    throw new Error(`unexpected command ${args[0]}`);
  });
  return {
    sendCommand: /** @type {(...args: string[]) => Promise<any>} */ (sendCommand),
    up: () => {
      reachable = true;
    },
  };
}

describe("FailurePolicyStore — Redis unreachable when the process starts (step 75)", () => {
  it("leaves no rejection unhandled: before step 75 the process exited at boot", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const inner = {
        ...brokenStore(),
        init: vi.fn().mockRejectedValue(new Error("down")),
      };
      new FailurePolicyStore({ store: inner, policy: "closed" }).init({
        windowMs: 1_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("is needed: the real store alone stays failed after Redis comes back", async () => {
    // rate-limit-redis keeps the rejected script promises and awaits them
    // on every increment; only a NOSCRIPT reply makes it load them again.
    // If a later version recovers by itself, this fails, and the retry in
    // FailurePolicyStore can go.
    const redis = redisDownAtBoot();
    const inner = new RedisStore({ sendCommand: redis.sendCommand });
    await inner.init(/** @type {any} */ ({ windowMs: 60_000 })).catch(() => {});
    redis.up();
    await expect(inner.increment("user:a")).rejects.toThrow(/max retries/);
  });

  it("recovers once Redis is back: the analyze path is not refused until a restart", async () => {
    const redis = redisDownAtBoot();
    const store = new FailurePolicyStore({
      store: new RedisStore({ sendCommand: redis.sendCommand }),
      policy: "closed",
    });
    store.init({ windowMs: 60_000 });

    await expect(store.increment("user:a")).rejects.toMatchObject({
      code: "SERVER_BUSY",
    });
    redis.up();
    await expect(store.increment("user:a")).resolves.toMatchObject({ totalHits: 1 });
    await expect(store.increment("user:a")).resolves.toMatchObject({ totalHits: 2 });
  });

  it.each(/** @type {const} */ (["closed", "open"]))(
    "applies the %s policy while the store cannot initialise",
    async (policy) => {
      const onFailure = vi.fn();
      const cause = new Error("down");
      const inner = { ...workingStore(), init: vi.fn().mockRejectedValue(cause) };
      const store = new FailurePolicyStore({ store: inner, policy, onFailure });
      store.init({ windowMs: 1_000 });

      const outcome = await store.increment("k").catch((e) => e);
      if (policy === "closed") expect(outcome).toMatchObject({ code: "SERVER_BUSY" });
      else expect(outcome).toMatchObject({ totalHits: 1 });
      expect(onFailure).toHaveBeenCalledWith(cause, policy);
      expect(inner.increment).not.toHaveBeenCalled();
    },
  );

  it("shares one retry among the requests that arrive while it runs", async () => {
    const init = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(undefined);
    const store = new FailurePolicyStore({
      store: { ...workingStore(), init },
      policy: "closed",
    });
    store.init({ windowMs: 1_000 });

    await Promise.all([store.increment("a"), store.increment("b"), store.increment("c")]);
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("tries again after a retry fails, and reports each failed request once", async () => {
    const onFailure = vi.fn();
    const init = vi
      .fn()
      .mockRejectedValueOnce(new Error("down at boot"))
      .mockRejectedValueOnce(new Error("still down"))
      .mockResolvedValue(undefined);
    const inner = { ...workingStore(), init };
    const store = new FailurePolicyStore({ store: inner, policy: "closed", onFailure });
    store.init({ windowMs: 1_000 });

    await expect(store.increment("k")).rejects.toMatchObject({ code: "SERVER_BUSY" });
    await expect(store.increment("k")).resolves.toMatchObject({ totalHits: 3 });
    expect(init).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("treats an init that throws synchronously the same way", async () => {
    const init = vi.fn(() => {
      throw new Error("bad options");
    });
    const store = new FailurePolicyStore({
      store: { ...workingStore(), init },
      policy: "open",
    });
    expect(() => store.init({ windowMs: 1_000 })).not.toThrow();
    await expect(store.increment("k")).resolves.toMatchObject({ totalHits: 1 });
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
