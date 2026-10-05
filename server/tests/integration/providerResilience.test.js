import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { getRedis } from "../../src/lib/redis.js";
import { countWords } from "../../src/services/extraction.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { getLlmProvider } from "../../src/services/llm/index.js";
import { MockLlmProvider } from "../../src/services/llm/mockProvider.js";
import {
  assertCircuitClosed,
  recordProviderCall,
  getCircuitState,
  resetCircuitForTests,
  MIN_CALLS,
  OPEN_MS,
} from "../../src/services/llm/circuitBreaker.js";
import { createDocument, createUser } from "./factories.js";

/**
 * TR-17 (SRS §10.3) — provider resilience: FR-3.10, FR-3.11, FR-3.12.
 *
 * The breaker's state is in Redis, which is the requirement rather than
 * an implementation detail: with two or more stateless instances a
 * per-process breaker sees only its own share of the traffic, so it needs
 * N times the failures to reach the same threshold and opens late — or,
 * on a large enough fleet, never. "Proven across two instances" is
 * therefore asserted directly, by having one caller record the failures
 * and a DIFFERENT caller find the circuit open.
 */

const CONTRACT = [
  "MASTER SERVICES AGREEMENT",
  "1. Fees. Client shall pay each invoice within thirty (30) days.",
  "2. Term. Either party may terminate on thirty (30) days' notice.",
].join("\n\n");

function mockProvider() {
  const backend = getLlmProvider().backend;
  if (!(backend instanceof MockLlmProvider))
    throw new Error("expected the mock provider");
  return backend;
}

async function ownedDocument() {
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

beforeEach(async () => {
  await resetCircuitForTests();
});

describe("TR-17 — transient failures are retried, then give up honestly (FR-3.10)", () => {
  it("retries a 529 storm to the budget, then 503 LLM_UNAVAILABLE with Retry-After", async () => {
    const { document, cookie } = await ownedDocument();
    // Three 529s: the first attempt plus FR-3.10's two retries.
    for (let i = 0; i < 3; i++) mockProvider().scriptHttpError(529);

    const res = await analyze(document.id, cookie);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("LLM_UNAVAILABLE");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(mockProvider().calls).toHaveLength(3);
    // FR-3.5: even an exhausted analysis leaves a record.
    expect(
      await prisma.analysis.count({
        where: {
          documentId: document.id,
          status: "FAILED",
          errorCode: "LLM_UNAVAILABLE",
        },
      }),
    ).toBe(1);
  }, 30_000);

  it("recovers silently when a retry succeeds — the user sees one good report", async () => {
    const { document, cookie } = await ownedDocument();
    mockProvider().scriptHttpError(529);
    mockProvider().scriptValidResponse({ overall_risk: "low", findings: [] });

    const res = await analyze(document.id, cookie);

    expect(res.status).toBe(200);
    expect(mockProvider().calls).toHaveLength(2);
    expect(
      await prisma.analysis.count({
        where: { documentId: document.id, status: "COMPLETED" },
      }),
    ).toBe(1);
  }, 30_000);
});

describe("TR-17 — a 401 is a configuration defect, not a transient failure (FR-3.11)", () => {
  it("is never retried, and reaches the user as 500 INTERNAL", async () => {
    const { document, cookie } = await ownedDocument();
    mockProvider().scriptHttpError(401);

    const res = await analyze(document.id, cookie);

    // One call only: waiting does not fix a bad key.
    expect(mockProvider().calls).toHaveLength(1);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL");
    // Not 503 with a Retry-After: telling the user to try again in a
    // minute would be a lie about something no wait repairs.
    expect(res.status).not.toBe(503);
  });

  it("raises the llm_config_error alert, because a bad key must page someone", async () => {
    const { default: logger } = await import("../../src/observability/logger.js");
    const spy = vi.spyOn(logger, "error");
    const { document, cookie } = await ownedDocument();
    mockProvider().scriptHttpError(401);

    await analyze(document.id, cookie);

    const alerted = spy.mock.calls.some(
      ([fields]) =>
        /** @type {{ alert?: string }} */ (fields)?.alert === "llm_config_error",
    );
    expect(alerted).toBe(true);
    spy.mockRestore();
  });

  it.each([400, 403, 404])("does not retry a %i either", async (status) => {
    const { document, cookie } = await ownedDocument();
    mockProvider().scriptHttpError(status);

    await analyze(document.id, cookie);

    expect(mockProvider().calls).toHaveLength(1);
  });
});

describe("TR-17 — the circuit breaker (FR-3.12)", () => {
  it("opens at 50% failures over 20 calls, and then refuses without a provider call", async () => {
    const { document, cookie } = await ownedDocument();
    for (let i = 0; i < MIN_CALLS; i++)
      await recordProviderCall(i % 2 === 0 ? "failure" : "success");

    await expect(getCircuitState()).resolves.toMatchObject({
      open: true,
      calls: MIN_CALLS,
      failures: 10,
    });

    mockProvider().scriptValidResponse({ overall_risk: "low", findings: [] });
    const res = await analyze(document.id, cookie);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("LLM_UNAVAILABLE");
    // The point of the breaker: no call at all, so an outage stops
    // queueing 60-second timeouts and exhausting server connections.
    expect(mockProvider().calls).toHaveLength(0);
  });

  it("does not open below the minimum call count, however bad the ratio", async () => {
    // 100% failures over 19 calls is still too little evidence: a breaker
    // that opened on a handful of calls would trip on ordinary noise.
    for (let i = 0; i < MIN_CALLS - 1; i++) await recordProviderCall("failure");
    await expect(getCircuitState()).resolves.toMatchObject({ open: false });
    await expect(assertCircuitClosed()).resolves.toBeUndefined();
  });

  it("does not open below the failure ratio, however many calls", async () => {
    for (let i = 0; i < 40; i++)
      await recordProviderCall(i % 4 === 0 ? "failure" : "success");
    await expect(getCircuitState()).resolves.toMatchObject({ open: false });
  });

  it("holds across instances: one caller's failures open the circuit for another", async () => {
    // This is the assertion a process-local breaker fails. The state is in
    // Redis, so the failures recorded here are visible to every instance —
    // including ones that never saw a single failing call.
    for (let i = 0; i < MIN_CALLS; i++) await recordProviderCall("failure");

    // A "second instance": its own module state, the same Redis.
    vi.resetModules();
    const fresh = await import("../../src/services/llm/circuitBreaker.js");
    await expect(fresh.assertCircuitClosed()).rejects.toMatchObject({
      code: "LLM_UNAVAILABLE",
    });
    vi.resetModules();
  });

  it("allows exactly ONE trial once the open period has elapsed", async () => {
    for (let i = 0; i < MIN_CALLS; i++) await recordProviderCall("failure");
    const after = new Date(Date.now() + OPEN_MS + 1_000);

    // The first caller past the open window becomes the trial.
    await expect(assertCircuitClosed(after)).resolves.toBeUndefined();
    // Every other caller is still refused — "a single trial" means one
    // across the fleet, or a recovering provider gets one trial per
    // instance at once, which is the storm the breaker prevents.
    await expect(assertCircuitClosed(after)).rejects.toMatchObject({
      code: "LLM_UNAVAILABLE",
    });
  });

  it("closes on a successful trial, and clears the failures that opened it", async () => {
    for (let i = 0; i < MIN_CALLS; i++) await recordProviderCall("failure");
    const after = new Date(Date.now() + OPEN_MS + 1_000);
    await assertCircuitClosed(after);

    await recordProviderCall("success", after);

    // Clearing the window matters: leaving the old failures would re-open
    // the breaker on the next single failure, so one trial success would
    // buy one call rather than a recovery.
    await expect(getCircuitState()).resolves.toMatchObject({ open: false, calls: 0 });
    await expect(assertCircuitClosed()).resolves.toBeUndefined();
  });

  it("stays tripped in REAL time past the open period, so there is a half-open state to trial in (step 75)", async () => {
    // The two tests above move the clock forward while the key is still
    // there. In real time the key used to expire at the very instant the
    // open period ended, so the trial never happened and every request in
    // the gap reached the provider: step 75's drill saw four openings in
    // five minutes and not one trial. The key has to outlive the period.
    for (let i = 0; i < MIN_CALLS; i++) await recordProviderCall("failure");
    const ttl = await getRedis().pttl("llm:cb:open_until");
    expect(ttl).toBeGreaterThan(OPEN_MS + 60_000);
    // ...but not forever: with no traffic at all, it lapses.
    expect(ttl).toBeLessThanOrEqual(OPEN_MS + 5 * 60_000);
  });

  it("a failed trial opens it again for a full period, with a trial slot of its own", async () => {
    for (let i = 0; i < MIN_CALLS; i++) await recordProviderCall("failure");
    const halfOpen = new Date(Date.now() + OPEN_MS + 1_000);
    await expect(assertCircuitClosed(halfOpen)).resolves.toBeUndefined(); // the trial

    await recordProviderCall("failure", halfOpen);

    // Open again: refused, trial or not, until another OPEN_MS has passed.
    await expect(assertCircuitClosed(halfOpen)).rejects.toMatchObject({
      code: "LLM_UNAVAILABLE",
    });
    await expect(
      assertCircuitClosed(new Date(halfOpen.getTime() + OPEN_MS - 1_000)),
    ).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    // Then exactly one new trial.
    const next = new Date(halfOpen.getTime() + OPEN_MS + 1_000);
    await expect(assertCircuitClosed(next)).resolves.toBeUndefined();
    await expect(assertCircuitClosed(next)).rejects.toMatchObject({
      code: "LLM_UNAVAILABLE",
    });
  });

  it("half-open reads as tripped, so llm_circuit_state does not drop to 0 between open periods", async () => {
    for (let i = 0; i < MIN_CALLS; i++) await recordProviderCall("failure");
    const halfOpen = new Date(Date.now() + OPEN_MS + 1_000);
    await expect(getCircuitState(halfOpen)).resolves.toMatchObject({
      open: true,
      halfOpen: true,
    });
    await expect(getCircuitState()).resolves.toMatchObject({
      open: true,
      halfOpen: false,
    });

    await recordProviderCall("success", halfOpen);
    await expect(getCircuitState(halfOpen)).resolves.toMatchObject({
      open: false,
      halfOpen: false,
    });
  });

  it("fails OPEN when Redis is unreachable, rather than becoming a second outage", async () => {
    // The breaker protects the app from the provider. An unavailable
    // breaker must not itself stop analyses — FR-5.6 already fails the
    // analyze path closed when Redis is down, so this cannot become an
    // unmetered path.
    getRedis().disconnect();
    try {
      await expect(assertCircuitClosed()).resolves.toBeUndefined();
      await expect(recordProviderCall("failure")).resolves.toBeUndefined();
    } finally {
      await getRedis()
        .connect()
        .catch(() => {});
    }
  });
});
