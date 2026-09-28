import { describe, it, expect, vi, afterEach } from "vitest";
import { startReaper, stopReaper, REAP_INTERVAL_MS } from "../../src/jobs/reaper.js";

/**
 * The SCHEDULING half of step 60's reaper (§12.3's "every minute"),
 * tested against an injected `tick` rather than the real
 * `reapStaleAnalyses` — this is a unit test, no database. The reap
 * logic itself (the lock, the WHERE clause, what it does and does not
 * touch) is tested against a real Postgres in
 * tests/integration/reaper.test.js.
 */
describe("startReaper / stopReaper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks once immediately, then every REAP_INTERVAL_MS, until stopped", async () => {
    vi.useFakeTimers();
    const tick = vi
      .fn()
      .mockResolvedValue({ lockAcquired: true, staleCountAtStart: 0, reaped: 0 });

    const handle = startReaper({ tick });
    // The immediate call is fired synchronously but not awaited inside
    // startReaper (it's a fire-and-forget `.catch()`); flush microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(3);

    stopReaper(handle);
    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS * 3);
    // Stopped means stopped: no catch-up, no further calls at all.
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("a rejected tick is logged and swallowed, not thrown — the next tick still fires", async () => {
    vi.useFakeTimers();
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ lockAcquired: true, staleCountAtStart: 0, reaped: 0 });

    const handle = startReaper({ tick });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    // If the rejection above had propagated out of the interval callback,
    // Node would report an unhandled rejection and (depending on the
    // process's own listeners) this test run itself could crash rather
    // than merely fail an assertion — reaching this line at all is part
    // of what this test is checking.
    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);

    stopReaper(handle);
  });

  it("uses REAP_INTERVAL_MS by default — no call for anything shorter", async () => {
    vi.useFakeTimers();
    const tick = vi
      .fn()
      .mockResolvedValue({ lockAcquired: true, staleCountAtStart: 0, reaped: 0 });

    const handle = startReaper({ tick });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS - 1);
    expect(tick).toHaveBeenCalledTimes(1);

    stopReaper(handle);
  });
});
