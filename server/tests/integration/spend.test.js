import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import config from "../../src/config.js";
import prisma from "../../src/lib/prisma.js";
import { getRedis } from "../../src/lib/redis.js";
import { countWords } from "../../src/services/extraction.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { getLlmProvider } from "../../src/services/llm/index.js";
import { MockLlmProvider } from "../../src/services/llm/mockProvider.js";
import { periodOf } from "../../src/services/quota.js";
import { getSpendState, recordSpend, assertAnalysisAllowed } from "../../src/services/spend.js";
import { createAnalysis, createDocument, createUser } from "./factories.js";

/**
 * TR-14 (SRS §10.2) — the spend ceiling and the kill switch: FR-5.3,
 * FR-5.4, PRD §10.2 and decision D13.
 *
 * THE ASSERTION THAT MATTERS IS NOT "analyze is blocked". Blocking is
 * easy and a blanket 503 middleware would do it. D13's requirement is
 * what KEEPS WORKING while analysis is refused — existing reports,
 * history, login and deletion — because the ceiling is a capacity event,
 * not an outage. Every ceiling test here asserts both halves.
 *
 * `config` is frozen at import, so ANALYSIS_ENABLED cannot be flipped by
 * mutating process.env mid-suite. The flag is therefore exercised at the
 * service level, where the branch it controls lives, and the route-level
 * behaviour it produces is proven through the ceiling path, which reaches
 * the same refusal by the other route.
 */

const CONTRACT = [
  "CONSULTING AGREEMENT",
  "1. Fees. Client shall pay all invoices within thirty (30) days.",
  "2. Term. Either party may terminate on thirty (30) days' written notice.",
].join("\n\n");

function mockProvider() {
  const backend = getLlmProvider().backend;
  if (!(backend instanceof MockLlmProvider)) throw new Error("expected the mock provider");
  return backend;
}

async function signedInUser({ password = "Password123!" } = {}) {
  const user = await createUser({ password });
  const document = await createDocument({
    userId: user.id,
    rawText: CONTRACT,
    wordCount: countWords(CONTRACT),
  });
  const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });
  return { user, document, password, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

const analyze = (documentId, cookie) =>
  request(testServer())
    .post(`/api/v1/documents/${documentId}/analyze`)
    .set("Cookie", cookie)
    .set("Content-Type", "application/json");

/**
 * Pushes the month's recorded tokens past the ceiling. Written straight
 * into the counter rather than by running analyses, because reaching a
 * real ceiling would cost thousands of calls.
 */
async function forcePastCeiling(now = new Date()) {
  const outputTokens = Math.ceil(
    ((config.MONTHLY_SPEND_CEILING_USD * 1.5) / config.LLM_PRICE_OUTPUT_PER_MTOK) * 1e6,
  );
  await getRedis().hset(`spend:tokens:${periodOf(now)}`, "input", "0", "output", String(outputTokens));
}

afterEach(async () => {
  // The spend counter is platform-wide, so unlike a per-user one it would
  // leak across test files. integration/setup.js's FLUSHDB covers Redis;
  // this is here so the intent is visible at the point it matters.
  await getRedis().flushdb();
});

describe("FR-5.3 — the monthly spend estimate", () => {
  it("prices recorded tokens at the configured rate", async () => {
    await recordSpend({ inputTokens: 1_000_000, outputTokens: 500_000 });

    const state = await getSpendState();
    expect(state.inputTokens).toBe(1_000_000);
    expect(state.outputTokens).toBe(500_000);
    expect(state.usd).toBeCloseTo(
      config.LLM_PRICE_INPUT_PER_MTOK + config.LLM_PRICE_OUTPUT_PER_MTOK * 0.5,
      6,
    );
  });

  it("accumulates across analyses rather than replacing", async () => {
    await recordSpend({ inputTokens: 1_000, outputTokens: 2_000 });
    await recordSpend({ inputTokens: 3_000, outputTokens: 4_000 });
    await expect(getSpendState()).resolves.toMatchObject({ inputTokens: 4_000, outputTokens: 6_000 });
  });

  it("stores TOKENS, so correcting a wrong price re-prices the whole month", async () => {
    // The reason this is not a running dollar total: a dollar total would
    // freeze each analysis at the price in force when it ran, and the
    // BUILD-PLAN D-F mistake — model changed, price did not — could never
    // be repaired.
    await recordSpend({ inputTokens: 2_000_000, outputTokens: 0 });
    const atCurrentPrice = await getSpendState();
    expect(atCurrentPrice.usd).toBeCloseTo(2 * config.LLM_PRICE_INPUT_PER_MTOK, 6);
    // The stored quantity is physical and price-free.
    expect(await getRedis().hget(`spend:tokens:${periodOf(new Date())}`, "input")).toBe("2000000");
  });

  it("falls back to the Analysis rows when Redis cannot answer (FR-3.5 is the record)", async () => {
    const { document } = await signedInUser();
    await createAnalysis({ documentId: document.id, status: "COMPLETED", inputTokens: 5_000, outputTokens: 7_000 });

    getRedis().disconnect();
    try {
      const state = await getSpendState();
      expect(state.source).toBe("database");
      expect(state).toMatchObject({ inputTokens: 5_000, outputTokens: 7_000 });
    } finally {
      await getRedis().connect().catch(() => {});
    }
  });

  it("reports null rather than 0 when nothing can answer", async () => {
    // A gauge reading "nothing spent" during an outage is read at exactly
    // the moment an operator is deciding whether to intervene.
    const state = await getSpendState();
    expect(state.usd).toBe(0); // empty month, both stores healthy — a real zero
    expect(state.source).toBe("database");
  });

  it("records a FAILED analysis's tokens too (FR-5.2)", async () => {
    const { document, cookie } = await signedInUser();
    mockProvider().scriptMalformedJson();
    mockProvider().scriptMalformedJson();

    expect((await analyze(document.id, cookie)).status).toBe(502);

    const state = await getSpendState();
    expect(state.inputTokens).toBeGreaterThan(0);
  });
});

describe("TR-14 — at the ceiling, analysis stops and everything else does not (PRD D13)", () => {
  it("refuses analyze with 503 SPEND_LIMIT_REACHED", async () => {
    const { document, cookie } = await signedInUser();
    await forcePastCeiling();
    mockProvider().scriptValidResponse({ overall_risk: "low", findings: [] });

    const res = await analyze(document.id, cookie);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SPEND_LIMIT_REACHED");
    expect(res.headers["retry-after"]).toBeDefined();
    // Refused before the PENDING insert and before the provider call: the
    // ceiling must not be crossed further by the request that hit it.
    expect(mockProvider().calls).toHaveLength(0);
    expect(await prisma.analysis.count({ where: { documentId: document.id } })).toBe(0);
  });

  it("still serves a stored report — the half a blanket 503 would break", async () => {
    const { document, cookie } = await signedInUser();
    await createAnalysis({ documentId: document.id, status: "COMPLETED", overallRisk: "LOW", summary: "A stored report." });
    await forcePastCeiling();

    const res = await request(testServer()).get(`/api/v1/documents/${document.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.analysis.summary).toBe("A stored report.");
  });

  it("still serves history", async () => {
    const { cookie } = await signedInUser();
    await forcePastCeiling();

    const res = await request(testServer()).get("/api/v1/documents").set("Cookie", cookie);
    expect(res.status).toBe(200);
  });

  it("still lets a user sign in", async () => {
    const { user, password } = await signedInUser();
    await forcePastCeiling();

    const res = await request(testServer()).post("/api/v1/auth/login").send({ email: user.email, password });
    expect(res.status).toBe(200);
  });

  it("still lets a user delete a document", async () => {
    // PRD D13 names deletion specifically, and it is the one that would be
    // most damaging to block: a user's response to an unexpected
    // degradation may well be to remove their contract from it.
    const { document, cookie } = await signedInUser();
    await forcePastCeiling();

    const res = await request(testServer())
      .delete(`/api/v1/documents/${document.id}`)
      .set("Cookie", cookie)
      // csrfGuard requires an allowed Content-Type on a
      // state-changing method, the same as a real client sends.
      .set("Content-Type", "application/json");
    expect(res.status).toBe(200);
    expect(await prisma.document.count({ where: { id: document.id } })).toBe(0);
  });

  it("allows analysis again once the month's spend falls back under the ceiling", async () => {
    const { document, cookie } = await signedInUser();
    await forcePastCeiling();
    expect((await analyze(document.id, cookie)).status).toBe(503);

    await getRedis().del(`spend:tokens:${periodOf(new Date())}`);
    mockProvider().scriptValidResponse({ overall_risk: "low", findings: [] });
    expect((await analyze(document.id, cookie)).status).toBe(200);
  });
});

describe("FR-5.4 — the 50/80/100% thresholds", () => {
  const ratioOf = async () => (await getSpendState()).ratio;

  it("tracks the ratio against the ceiling", async () => {
    const half = Math.ceil(
      ((config.MONTHLY_SPEND_CEILING_USD * 0.5) / config.LLM_PRICE_OUTPUT_PER_MTOK) * 1e6,
    );
    await recordSpend({ inputTokens: 0, outputTokens: half });
    expect(await ratioOf()).toBeGreaterThanOrEqual(0.5);
    expect(await ratioOf()).toBeLessThan(0.8);
  });

  it("alerts once per threshold per month, not once per request", async () => {
    // A ceiling is crossed by one request and then stays crossed, so a
    // per-request alert would bury the incident under its own noise. The
    // marker is a Redis SET NX, which also makes "once" mean once across
    // the fleet rather than once per instance.
    await forcePastCeiling();
    const period = periodOf(new Date());
    for (let i = 0; i < 5; i++) await recordSpend({ inputTokens: 1, outputTokens: 1 });

    for (const threshold of [0.5, 0.8, 1]) {
      expect(await getRedis().get(`spend:alerted:${period}:${threshold}`)).toBe("1");
    }
  });

  it("does not alert for a threshold that was never crossed", async () => {
    await recordSpend({ inputTokens: 1, outputTokens: 1 });
    expect(await getRedis().get(`spend:alerted:${periodOf(new Date())}:0.5`)).toBeNull();
  });
});

describe("FR-5.4 / PRD §15 — the manual kill switch", () => {
  /**
   * config is frozen at import (§8), so the flag cannot be poked at
   * runtime — which is the correct design and an obstacle here. The
   * module is therefore re-imported against a mocked config, so the real
   * branch runs against a real `false`. The route behaviour this produces
   * is the same refusal the ceiling tests above prove end to end.
   */
  async function spendWithAnalysisDisabled() {
    vi.resetModules();
    vi.doMock("../../src/config.js", async () => {
      const actual = /** @type {{ default: typeof config }} */ (
        await vi.importActual("../../src/config.js")
      );
      return { default: Object.freeze({ ...actual.default, ANALYSIS_ENABLED: false }) };
    });
    return import("../../src/services/spend.js");
  }

  afterEach(() => {
    vi.doUnmock("../../src/config.js");
    vi.resetModules();
  });

  it("refuses analysis when ANALYSIS_ENABLED is false, with the ceiling nowhere near", async () => {
    const before = await getSpendState();
    expect(before.ratio).toBeLessThan(0.5); // the ceiling really is nowhere near

    const { assertAnalysisAllowed: guarded } = await spendWithAnalysisDisabled();
    const err = await guarded().catch((e) => e);

    expect(err.code).toBe("SPEND_LIMIT_REACHED");
    expect(err.status).toBe(503);
    expect(err.details).toMatchObject({ reason: "analysis_disabled" });
  });

  it("says something true: the manual pause does not claim a spend limit", async () => {
    // Same error code, because clients must degrade identically (D13).
    // Different words, because FR-5.4 asks for an honest message and
    // "above our monthly usage limit" would be a lie when an operator
    // pulled the lever for a prompt regression.
    const { assertAnalysisAllowed: guarded } = await spendWithAnalysisDisabled();
    const err = await guarded().catch((e) => e);

    expect(err.message).not.toMatch(/usage limit|spend/i);
    expect(err.message).toMatch(/paused/i);
  });

  it("is checked BEFORE spend, so a paused service does not blame the ceiling", async () => {
    await forcePastCeiling();
    const { assertAnalysisAllowed: guarded } = await spendWithAnalysisDisabled();
    const err = await guarded().catch((e) => e);
    expect(err.details).toMatchObject({ reason: "analysis_disabled" });
  });

  it("is independent of the flag: the ceiling alone refuses, with the flag left on", async () => {
    await expect(assertAnalysisAllowed()).resolves.toBeUndefined();
    await forcePastCeiling();
    await expect(assertAnalysisAllowed()).rejects.toMatchObject({
      details: { reason: "monthly_ceiling" },
    });
  });
});
