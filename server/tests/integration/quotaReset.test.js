import { describe, it, expect } from "vitest";
import { Registry } from "prom-client";
import prisma from "../../src/lib/prisma.js";
import { getRedis } from "../../src/lib/redis.js";
import { createJobLastSuccessGauge, recordJobSuccess } from "../../src/jobs/jobRuns.js";
import { quotaResetTick, runQuotaReset } from "../../src/jobs/quotaReset.js";
import { periodOf, periodStartOf } from "../../src/services/quota.js";
import { createUser } from "./factories.js";

/**
 * SRS §12.3's quota-reset. `now` is pinned in every test, and it is
 * always in a different month from the users' stale periods, so "the
 * first of the month" is a fact of the fixture rather than of the clock.
 */

const NOW = new Date("2026-07-01T00:30:00.000Z");
const PERIOD_START = periodStartOf(NOW);
const LAST_MONTH = new Date("2026-06-10T12:00:00.000Z");
const LAST_MONTH_START = periodStartOf(LAST_MONTH);

async function userInPeriod(quotaPeriodStart, monthlyAnalyses) {
  return createUser({ quotaPeriodStart, monthlyAnalyses });
}

const reload = (id) => prisma.user.findUniqueOrThrow({ where: { id } });

describe("runQuotaReset (SRS §12.3)", () => {
  it("zeroes the monthly counter and advances quotaPeriodStart for a user still on last month's period", async () => {
    const user = await userInPeriod(LAST_MONTH_START, 37);

    const result = await runQuotaReset(NOW);

    expect(result).toEqual({ lockAcquired: true, ran: true, reset: 1 });
    const after = await reload(user.id);
    expect(after.monthlyAnalyses).toBe(0);
    expect(after.quotaPeriodStart).toEqual(PERIOD_START);
  }, 30_000);

  it("leaves a user who has already analysed this month alone: their real count is not zeroed", async () => {
    // Rolled lazily by quota.js at their first analysis of the month, so
    // quotaPeriodStart is already AT this period's start. The reset's
    // WHERE must exclude them, or the job would erase real usage.
    const active = await userInPeriod(PERIOD_START, 4);
    const stale = await userInPeriod(LAST_MONTH_START, 9);

    const result = await runQuotaReset(NOW);

    expect(result.reset).toBe(1);
    expect((await reload(active.id)).monthlyAnalyses).toBe(4);
    expect((await reload(stale.id)).monthlyAnalyses).toBe(0);
  }, 30_000);

  it("resets every stale user, not just one, and reports how many", async () => {
    await userInPeriod(LAST_MONTH_START, 1);
    await userInPeriod(new Date("2026-03-01T00:00:00.000Z"), 50);
    await userInPeriod(new Date("2025-12-01T00:00:00.000Z"), 12);

    const result = await runQuotaReset(NOW);

    expect(result.reset).toBe(3);
    expect(await prisma.user.count({ where: { quotaPeriodStart: { lt: PERIOD_START } } })).toBe(0);
    expect(await prisma.user.count({ where: { monthlyAnalyses: { gt: 0 } } })).toBe(0);
  }, 30_000);

  it("does not touch the HOURLY counters: the rolling-hour sorted set and the period-keyed month counter survive", async () => {
    const user = await userInPeriod(LAST_MONTH_START, 20);
    const redis = getRedis();
    const hourKey = `quota:hour:${user.id}`;
    // A fresh entry inside the rolling hour, and this month's Redis
    // counter, which the metering keyed by period so it is already the
    // NEW month's and must not be reset.
    await redis.zadd(hourKey, String(NOW.getTime() - 5 * 60 * 1000), "recent-analysis");
    await redis.set(`quota:month:${user.id}:${periodOf(NOW)}`, "3");
    const before = await redis.zrange(hourKey, "0", "-1", "WITHSCORES");

    await runQuotaReset(NOW);

    // Anti-vacuity: the database row really did reset, so this is a
    // reset that ran and left Redis alone, not a reset that did nothing.
    expect((await reload(user.id)).monthlyAnalyses).toBe(0);
    expect(await redis.zrange(hourKey, "0", "-1", "WITHSCORES")).toEqual(before);
    expect(await redis.get(`quota:month:${user.id}:${periodOf(NOW)}`)).toBe("3");
  }, 30_000);

  it("never resets a period twice: idempotent on an already-current user", async () => {
    const user = await userInPeriod(LAST_MONTH_START, 6);
    await runQuotaReset(NOW);
    // The user analyses once in the new month, then the job runs again.
    await prisma.user.update({ where: { id: user.id }, data: { monthlyAnalyses: 1 } });

    const second = await runQuotaReset(new Date(NOW.getTime() + 60 * 60 * 1000));

    expect(second.reset).toBe(0);
    expect((await reload(user.id)).monthlyAnalyses).toBe(1);
  }, 30_000);
});

describe("the due-check, the lock and the metric", () => {
  it("records its success, readable by a second instance that never ran the job", async () => {
    const instanceB = createJobLastSuccessGauge({ registers: [new Registry()] });
    await userInPeriod(LAST_MONTH_START, 2);

    await quotaResetTick(NOW);

    const metric = await instanceB.get();
    const series = metric.values.find((v) => v.labels.job === "quota-reset");
    expect(series?.value).toBe(Math.floor(NOW.getTime() / 1000));
  }, 30_000);

  it("a second tick in the same month does nothing, even though a user has become stale in between", async () => {
    await quotaResetTick(NOW);
    const late = await userInPeriod(LAST_MONTH_START, 8);

    const second = await quotaResetTick(new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000));

    expect(second).toEqual({ lockAcquired: true, ran: false });
    expect((await reload(late.id)).monthlyAnalyses).toBe(8);
  }, 30_000);

  it("runs again in the next month", async () => {
    await quotaResetTick(NOW);
    const user = await userInPeriod(periodStartOf(NOW), 15);

    const nextMonth = new Date("2026-08-01T00:10:00.000Z");
    const result = await quotaResetTick(nextMonth);

    expect(result.ran).toBe(true);
    const after = await reload(user.id);
    expect(after.monthlyAnalyses).toBe(0);
    expect(after.quotaPeriodStart).toEqual(periodStartOf(nextMonth));
  }, 30_000);

  it("a run that loses the lock resets nothing and records no success", async () => {
    const user = await userInPeriod(LAST_MONTH_START, 11);
    await recordJobSuccess("quota-reset", new Date("2026-06-01T00:10:00.000Z"));

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('quota-reset:monthly'))`;
      const result = await runQuotaReset(NOW);
      expect(result).toEqual({ lockAcquired: false, ran: false });
    });

    expect((await reload(user.id)).monthlyAnalyses).toBe(11);
    const row = await prisma.jobRun.findUniqueOrThrow({ where: { job: "quota-reset" } });
    expect(row.lastSuccessAt).toEqual(new Date("2026-06-01T00:10:00.000Z"));
  }, 30_000);

  it("two concurrent runs: exactly one holds the lock", async () => {
    await userInPeriod(LAST_MONTH_START, 5);
    const [a, b] = await Promise.all([runQuotaReset(NOW), runQuotaReset(NOW)]);
    expect([a, b].filter((r) => r.lockAcquired)).toHaveLength(1);
  }, 30_000);
});
