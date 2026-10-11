import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Step 75: dependency_up, FR-4.7's readiness as a metric. readiness_failing
 * reads it since the platform's health check became /api/health (ops/render
 * says why). What matters: each dependency reported on its own, and a check
 * that hangs counts as down within the bound instead of stalling the scrape.
 */
vi.mock("../../src/lib/readinessChecks.js", () => ({
  checkPostgres: vi.fn(),
  checkRedis: vi.fn(),
}));
const { checkPostgres, checkRedis } = await import("../../src/lib/readinessChecks.js");
const { dependencyUp, DEPENDENCY_CHECK_TIMEOUT_MS } =
  await import("../../src/observability/metrics.js");

/** @returns {Promise<Record<string, number>>} */
async function read() {
  const { values } = await dependencyUp.get();
  return Object.fromEntries(values.map((v) => [String(v.labels.dependency), v.value]));
}

describe("dependency_up (step 75)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reports each dependency on its own: 1 reachable, 0 not", async () => {
    vi.mocked(checkPostgres).mockResolvedValue({ ok: true });
    vi.mocked(checkRedis).mockResolvedValue({ ok: false, error: "ECONNREFUSED" });
    expect(await read()).toEqual({ postgres: 1, redis: 0 });

    vi.mocked(checkPostgres).mockResolvedValue({ ok: false, error: "P1001" });
    vi.mocked(checkRedis).mockResolvedValue({ ok: true });
    expect(await read()).toEqual({ postgres: 0, redis: 1 });
  });

  it("a check that hangs counts as down after the bound, so the scrape still answers", async () => {
    vi.useFakeTimers();
    vi.mocked(checkPostgres).mockReturnValue(new Promise(() => {}));
    vi.mocked(checkRedis).mockResolvedValue({ ok: true });

    const reading = read();
    await vi.advanceTimersByTimeAsync(DEPENDENCY_CHECK_TIMEOUT_MS);
    expect(await reading).toEqual({ postgres: 0, redis: 1 });
  });

  it("the bound stays well inside Prometheus's default 10 s scrape timeout", () => {
    expect(DEPENDENCY_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
