import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { getRedis } from "../../src/lib/redis.js";
import { countWords } from "../../src/services/extraction.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { getLlmProvider } from "../../src/services/llm/index.js";
import { MockLlmProvider } from "../../src/services/llm/mockProvider.js";
import {
  assertWithinQuota,
  consumeQuota,
  getQuotaState,
  periodOf,
  nextPeriodStart,
} from "../../src/services/quota.js";
import { createDocument, createUser } from "./factories.js";

/**
 * TR-13 (SRS §10.2) — quota metering: FR-5.1, FR-5.2, FR-5.5.
 *
 * A TRAP THIS FILE IS WRITTEN AROUND. analyzeLimiter (NFR-2.6) also caps
 * analyses at 10 per user per hour, and it sits in middleware, ahead of
 * the orchestrator. A test that simply posted eleven analyses and asserted
 * 429 RATE_LIMITED would pass without the quota service existing at all —
 * it would be reading the limiter's answer. So the hourly limit is proven
 * at the service level, where only the quota service can answer, and the
 * monthly limit is proven through the real route with the hourly counter
 * left at zero so the limiter cannot be what replies.
 */

const CONTRACT = [
  "SERVICES AGREEMENT",
  "1. Payment. Invoices are payable within thirty (30) days of receipt.",
  "2. Termination. Either party may terminate on fourteen (14) days' notice.",
].join("\n\n");

function mockProvider() {
  const backend = getLlmProvider().backend;
  if (!(backend instanceof MockLlmProvider))
    throw new Error("expected the mock provider");
  return backend;
}

async function userWithDocument() {
  const user = await createUser();
  const document = await createDocument({
    userId: user.id,
    rawText: CONTRACT,
    wordCount: countWords(CONTRACT),
  });
  const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });
  return { user, document, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

const analyze = (documentId, cookie) =>
  request(testServer())
    .post(`/api/v1/documents/${documentId}/analyze`)
    .set("Cookie", cookie)
    .set("Content-Type", "application/json");

/** Seeds the monthly counter in both stores, as a month of prior use. */
async function seedMonthlyUsage(userId, used, now = new Date()) {
  await getRedis().set(`quota:month:${userId}:${periodOf(now)}`, String(used));
  await prisma.user.update({
    where: { id: userId },
    data: { monthlyAnalyses: used, quotaPeriodStart: now },
  });
}

describe("TR-13 — the hourly limit (FR-5.1, 10 per rolling hour)", () => {
  it("refuses the 11th with RATE_LIMITED, at the service level where only quota can answer", async () => {
    const { user } = await userWithDocument();

    for (let i = 0; i < 10; i++) await consumeQuota(user.id);
    await expect(getQuotaState(user.id)).resolves.toMatchObject({ hourly: 10 });

    const err = await assertWithinQuota(user.id).catch((e) => e);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBeGreaterThan(0);
  });

  it("allows the 10th, so the limit is a ceiling and not an off-by-one", async () => {
    const { user } = await userWithDocument();
    for (let i = 0; i < 9; i++) await consumeQuota(user.id);
    await expect(assertWithinQuota(user.id)).resolves.toBeUndefined();
  });

  it("is a ROLLING hour: usage older than an hour no longer counts", async () => {
    // The difference from analyzeLimiter's fixed window, and the reason
    // this limit exists in two places. Entries are written with their own
    // timestamps, so an hour-old entry is pruned by the next read.
    const { user } = await userWithDocument();
    const key = `quota:hour:${user.id}`;
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) await getRedis().zadd(key, twoHoursAgo + i, `old-${i}`);

    await expect(getQuotaState(user.id)).resolves.toMatchObject({ hourly: 0 });
    await expect(assertWithinQuota(user.id)).resolves.toBeUndefined();
  });

  it("counts per user, so one user's hour does not spend another's", async () => {
    const a = await createUser();
    const b = await createUser();
    for (let i = 0; i < 10; i++) await consumeQuota(a.id);

    await expect(assertWithinQuota(a.id)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(assertWithinQuota(b.id)).resolves.toBeUndefined();
  });
});

describe("TR-13 — the monthly quota (FR-5.1, 50 per calendar month)", () => {
  it("the 51st analysis returns 429 QUOTA_EXCEEDED, through the real route", async () => {
    const { user, document, cookie } = await userWithDocument();
    // 50 used this month, but nothing in the last hour — so analyzeLimiter
    // has no reason to answer and the reply can only come from the quota
    // service.
    await seedMonthlyUsage(user.id, 50);
    mockProvider().scriptValidResponse({ overall_risk: "low", findings: [] });

    const res = await analyze(document.id, cookie);

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("QUOTA_EXCEEDED");
    expect(mockProvider().calls).toHaveLength(0);
  });

  it("states the reset date, so the message survives being read a week later", async () => {
    const { user, document, cookie } = await userWithDocument();
    await seedMonthlyUsage(user.id, 50);

    const res = await analyze(document.id, cookie);

    const resetsAt = nextPeriodStart(new Date());
    expect(res.body.error.message).toContain(String(resetsAt.getUTCFullYear()));
    expect(res.body.error.message).toMatch(/resets on \d/i);
  });

  it("allows the 50th — the quota is inclusive of its own number", async () => {
    const { user, document, cookie } = await userWithDocument();
    await seedMonthlyUsage(user.id, 49);
    mockProvider().scriptValidResponse({ overall_risk: "low", findings: [] });

    expect((await analyze(document.id, cookie)).status).toBe(200);
  });

  it("does not spend the quota it refused: a rejected analysis writes no row", async () => {
    const { user, document, cookie } = await userWithDocument();
    await seedMonthlyUsage(user.id, 50);

    await analyze(document.id, cookie);

    // Step 2 runs before the PENDING insert, so nothing was recorded and
    // the counter did not move either.
    expect(await prisma.analysis.count({ where: { documentId: document.id } })).toBe(0);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toMatchObject({
      monthlyAnalyses: 50,
    });
  });
});

describe("TR-13 — a FAILED analysis still increments both counters (FR-5.2)", () => {
  it("counts a provider failure, because it spent provider tokens all the same", async () => {
    // The requirement a natural implementation gets wrong: the obvious
    // home for an increment is the success branch, and a quota that only
    // counted successes would be a free retry loop.
    const { user, document, cookie } = await userWithDocument();
    mockProvider().scriptMalformedJson();
    mockProvider().scriptMalformedJson(); // the one retry FR-3.2 allows

    const res = await analyze(document.id, cookie);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("LLM_INVALID_OUTPUT");

    // Both stores, not just the fast one.
    await expect(getQuotaState(user.id)).resolves.toMatchObject({
      hourly: 1,
      monthly: 1,
    });
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toMatchObject({
      monthlyAnalyses: 1,
    });
    // And the analysis itself is on record as FAILED (FR-3.5).
    expect(
      await prisma.analysis.count({
        where: { documentId: document.id, status: "FAILED" },
      }),
    ).toBe(1);
  });

  it("counts a timeout the same way", async () => {
    const { user, document, cookie } = await userWithDocument();
    mockProvider().scriptTimeout();

    expect((await analyze(document.id, cookie)).status).toBe(504);
    await expect(getQuotaState(user.id)).resolves.toMatchObject({
      hourly: 1,
      monthly: 1,
    });
  });

  it("counts a success exactly once — the finally must not double-count", async () => {
    const { user, document, cookie } = await userWithDocument();
    mockProvider().scriptValidResponse({ overall_risk: "low", findings: [] });

    expect((await analyze(document.id, cookie)).status).toBe(200);
    await expect(getQuotaState(user.id)).resolves.toMatchObject({
      hourly: 1,
      monthly: 1,
    });
  });
});

describe("FR-5.1 — Redis is the fast path, the database is the fallback of record", () => {
  it("falls back to User.monthlyAnalyses when Redis cannot answer", async () => {
    const { user, document, cookie } = await userWithDocument();
    await prisma.user.update({
      where: { id: user.id },
      data: { monthlyAnalyses: 50, quotaPeriodStart: new Date() },
    });

    getRedis().disconnect();
    try {
      const res = await analyze(document.id, cookie);
      // analyzeLimiter fails closed first (FR-5.6), which is the correct
      // outcome for the user — but the point here is that the quota check
      // itself can still answer from the database. Assert that directly.
      expect(res.status).toBe(503);
      await expect(assertWithinQuota(user.id)).rejects.toMatchObject({
        code: "QUOTA_EXCEEDED",
      });
    } finally {
      await getRedis()
        .connect()
        .catch(() => {});
    }
  });

  it("reports unknown rather than zero when Redis is down (FR-5.5)", async () => {
    // A metric that reads "0 analyses used" during an outage is a lie, and
    // a lying metric is worse during an incident than one that admits it
    // does not know.
    const { user } = await userWithDocument();
    getRedis().disconnect();
    try {
      await expect(getQuotaState(user.id)).resolves.toMatchObject({
        hourly: null,
        monthly: null,
      });
    } finally {
      await getRedis()
        .connect()
        .catch(() => {});
    }
  });

  it("ignores a database count belonging to an earlier month", async () => {
    const { user } = await userWithDocument();
    const lastMonth = new Date(Date.UTC(2026, 0, 15));
    await prisma.user.update({
      where: { id: user.id },
      data: { monthlyAnalyses: 50, quotaPeriodStart: lastMonth },
    });

    getRedis().disconnect();
    try {
      await expect(assertWithinQuota(user.id)).resolves.toBeUndefined();
    } finally {
      await getRedis()
        .connect()
        .catch(() => {});
    }
  });

  it("rolls the database period over on the first analysis of a new month", async () => {
    const { user } = await userWithDocument();
    const lastMonth = new Date(Date.UTC(2026, 0, 15));
    await prisma.user.update({
      where: { id: user.id },
      data: { monthlyAnalyses: 37, quotaPeriodStart: lastMonth },
    });

    await consumeQuota(user.id);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    // Reset to 1, not incremented to 38, and the period moved with it.
    expect(after?.monthlyAnalyses).toBe(1);
    expect(periodOf(/** @type {Date} */ (after?.quotaPeriodStart))).toBe(
      periodOf(new Date()),
    );
  });

  it("never throws out of consumeQuota, even with Redis gone", async () => {
    // A counter that could fail an analysis the user already paid for
    // would trade a billing inaccuracy for a user-visible error.
    const { user } = await userWithDocument();
    getRedis().disconnect();
    try {
      await expect(consumeQuota(user.id)).resolves.toBeUndefined();
    } finally {
      await getRedis()
        .connect()
        .catch(() => {});
    }
    // The authoritative half still landed.
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toMatchObject({
      monthlyAnalyses: 1,
    });
  });
});
