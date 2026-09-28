import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDegraded,
  describeWait,
  getDegraded,
  markDegraded,
  resetDegradedForTests,
  subscribeDegraded,
} from "../../src/api/degraded.js";

afterEach(() => {
  resetDegradedForTests();
  vi.restoreAllMocks();
});

describe("degraded.js (FR-7.10)", () => {
  it("ignores codes that are not degraded-mode codes", () => {
    markDegraded("SERVER_BUSY", "x", 5, 0);
    expect(getDegraded(0)).toBeNull();
  });

  it("notifies subscribers when set, and again when it expires on read", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDegraded(listener);
    markDegraded("LLM_UNAVAILABLE", "x", 60, 1_000);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(getDegraded(60_999)).not.toBeNull();
    expect(getDegraded(61_000)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("returns the SAME object until it changes (useSyncExternalStore needs a stable snapshot)", () => {
    markDegraded("LLM_UNAVAILABLE", "x", 60, 0);
    expect(getDegraded(1)).toBe(getDegraded(2));
  });

  it("clearDegraded clears it", () => {
    markDegraded("SPEND_LIMIT_REACHED", "x", 60, 0);
    clearDegraded();
    expect(getDegraded(0)).toBeNull();
  });

  it("survives blocked storage: the in-memory copy still works", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    markDegraded("LLM_UNAVAILABLE", "x", 60, 0);
    expect(getDegraded(1)?.code).toBe("LLM_UNAVAILABLE");
  });
});

describe("describeWait", () => {
  it.each([
    [10_000, "in about a minute"],
    [60_000, "in about a minute"],
    [20 * 60_000, "in about 20 minutes"],
    [60 * 60_000, "in about an hour"],
    [3 * 60 * 60_000, "in about 3 hours"],
  ])("%i ms reads as %s", (ms, text) => {
    expect(describeWait(ms)).toBe(text);
  });
});
