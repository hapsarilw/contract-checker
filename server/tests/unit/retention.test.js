import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CATCH_UP_AFTER_MS,
  MIN_INTERVAL_MS,
  TICK_INTERVAL_MS,
  isDue,
  startRetentionJob,
  stopRetentionJob,
  subtractMonthsUTC,
} from "../../src/jobs/retention.js";

/**
 * The pure halves of the retention job: when it is due, and what "13
 * months ago" means. The deletes themselves run against a real Postgres in
 * tests/integration/retention.test.js.
 */

const HOUR_MS = 60 * 60 * 1000;
const at = (iso) => new Date(iso);

describe("isDue — nightly, as a due-check rather than a timer", () => {
  it("is due immediately if the job has never succeeded, at any hour", () => {
    expect(isDue(null, at("2026-06-15T14:00:00Z"))).toBe(true);
  });

  it("is due inside the 02:00-06:00 UTC window once 12 hours have passed", () => {
    expect(isDue(at("2026-06-14T03:00:00Z"), at("2026-06-15T03:00:00Z"))).toBe(true);
  });

  it("is NOT due outside the window between the 12-hour floor and the 30-hour catch-up", () => {
    // 17 hours after the last run, in the evening: past the floor, short
    // of the catch-up, and not night. Waits for the window.
    expect(isDue(at("2026-06-14T03:00:00Z"), at("2026-06-14T20:00:00Z"))).toBe(false);
  });

  it("is NOT due twice in one window — the 12-hour floor", () => {
    expect(isDue(at("2026-06-15T02:15:00Z"), at("2026-06-15T05:45:00Z"))).toBe(false);
  });

  it("the window's end is exclusive and its start inclusive", () => {
    const yesterday = at("2026-06-14T03:00:00Z");
    expect(isDue(yesterday, at("2026-06-15T02:00:00Z"))).toBe(true);
    expect(isDue(yesterday, at("2026-06-15T06:00:00Z"))).toBe(false);
  });

  it("catches up in daylight once 30 hours have passed, so a missed night does not reach the 36-hour alert", () => {
    const last = at("2026-06-14T03:00:00Z");
    expect(isDue(last, new Date(last.getTime() + CATCH_UP_AFTER_MS - 1))).toBe(false);
    expect(isDue(last, new Date(last.getTime() + CATCH_UP_AFTER_MS))).toBe(true);
    expect(CATCH_UP_AFTER_MS).toBeLessThan(36 * HOUR_MS);
  });

  it("drifts back to night after a daytime catch-up rather than settling into a 30-hour cycle", () => {
    // A catch-up at 09:00; the next window opens 17 hours later, past the
    // 12-hour floor, so it qualifies.
    const catchUp = at("2026-06-15T09:00:00Z");
    expect(isDue(catchUp, at("2026-06-16T02:00:00Z"))).toBe(true);
    expect(MIN_INTERVAL_MS).toBeLessThanOrEqual(17 * HOUR_MS);
  });
});

describe("subtractMonthsUTC — what '13 months ago' means", () => {
  it("subtracts calendar months, not a fixed number of days", () => {
    expect(subtractMonthsUTC(at("2026-06-15T03:00:00Z"), 13)).toEqual(at("2025-05-15T03:00:00Z"));
  });

  it("clamps to the end of a shorter month instead of spilling into the next", () => {
    // 31 March minus 13 months is 28 February, not 3 March.
    expect(subtractMonthsUTC(at("2026-03-31T00:00:00Z"), 13)).toEqual(at("2025-02-28T00:00:00Z"));
  });

  it("handles a leap day", () => {
    expect(subtractMonthsUTC(at("2025-03-29T00:00:00Z"), 13)).toEqual(at("2024-02-29T00:00:00Z"));
  });
});

describe("startRetentionJob / stopRetentionJob", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks once immediately and then every TICK_INTERVAL_MS, until stopped", async () => {
    vi.useFakeTimers();
    const tick = vi.fn().mockResolvedValue({ lockAcquired: true, ran: false });

    const handle = startRetentionJob({ tick });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);

    stopRetentionJob(handle);
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 4);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
