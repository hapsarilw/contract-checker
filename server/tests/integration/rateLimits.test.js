import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import express from "express";
import { countWords } from "../../src/services/extraction.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { createDocument, createUser } from "./factories.js";
import { createLimiter } from "../../src/middleware/rateLimits.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import { getRedis } from "../../src/lib/redis.js";

/**
 * BUILD-PLAN step 41 (OPS-2) / NFR-2.6 — the two scenarios this step's
 * own instructions name explicitly, run against the REAL app (real
 * routes, real requireAuth, the real generalLimiter/authLimiter/
 * analyzeLimiter mounted exactly where app.js/auth.js/documents.js
 * mount them), not the isolated bare-Express app
 * tests/integration/rateLimitBuckets.test.js uses to exercise the limiter
 * logic itself. This file is checking the WIRING; that one is checking
 * the COUNTING.
 *
 * Step 44 adds the two scenarios that only exist once the store is
 * shared: a limit that holds across instances, and FR-5.6's asymmetric
 * behaviour when the store is gone.
 */

const CONTRACT = [
  "DESIGN SERVICES AGREEMENT",
  "1. Payment. Invoices are payable within thirty (30) days of receipt.",
  "2. Termination. Either party may terminate this Agreement with 14 days' notice.",
].join("\n\n");

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

/** @param {string} documentId @param {string} cookie @param {string} [forwardedFor] */
function analyze(documentId, cookie, forwardedFor) {
  const req = request(testServer())
    .post(`/api/v1/documents/${documentId}/analyze`)
    .set("Cookie", cookie)
    .set("Content-Type", "application/json");
  return forwardedFor ? req.set("X-Forwarded-For", forwardedFor) : req;
}

describe("auth rate limiting on the real routes (NFR-2.6: 5 / 15 min / IP)", () => {
  it("the 6th auth attempt in a window returns 429 RATE_LIMITED, with Retry-After and a retry time in the message", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(testServer())
        .post("/api/v1/auth/login")
        .send({ email: "nobody@example.test", password: "wrong-password-entirely" });
      expect(res.status).toBe(401);
    }

    const blocked = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "nobody@example.test", password: "wrong-password-entirely" });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.body.error.message).toMatch(/in about \d+ (second|minute)s?/);
  });

  it("register and login share ONE combined counter per IP — 'auth attempts' is not per-route", async () => {
    for (let i = 0; i < 3; i++) {
      await request(testServer())
        .post("/api/v1/auth/register")
        .send({
          email: `combined-${i}@example.test`,
          password: "long-enough-password-1",
        });
    }
    for (let i = 0; i < 2; i++) {
      await request(testServer())
        .post("/api/v1/auth/login")
        .send({ email: "combined-0@example.test", password: "wrong" });
    }

    const blocked = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "combined-0@example.test", password: "wrong" });

    expect(blocked.status).toBe(429);
  });
});

describe("analyze rate limiting on the real routes (NFR-2.6: 10 / hour / user)", () => {
  it("the 11th analysis in an hour returns 429, keyed by user — proven by sending it from a different IP", async () => {
    const { document, cookie } = await ownedDocument();

    for (let i = 0; i < 10; i++) {
      const res = await analyze(document.id, cookie);
      expect(res.status).toBe(200);
    }

    // Same user (same session cookie), a source IP none of the first ten
    // requests used — still blocked, because the key is req.auth.userId,
    // never req.ip.
    const blocked = await analyze(document.id, cookie, "198.51.100.7");

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.body.error.message).toMatch(/in about \d+ (second|minute)s?/);
  });

  it("a different user, from the SAME IP as one already at their cap, is not affected", async () => {
    const first = await ownedDocument();
    for (let i = 0; i < 10; i++) {
      expect((await analyze(first.document.id, first.cookie)).status).toBe(200);
    }
    expect((await analyze(first.document.id, first.cookie)).status).toBe(429);

    const second = await ownedDocument();
    const res = await analyze(second.document.id, second.cookie);
    expect(res.status).toBe(200);
  });
});

describe("the limit holds across instances (step 44, §2's second critical constraint)", () => {
  it("two limiters over one Redis share a counter — what a memory store could not do", async () => {
    // Two limiter middlewares built from the same factory, mounted on two
    // separate Express apps. That is what a second API instance IS from
    // the counter's point of view: its own middleware object, its own
    // store object, the same Redis behind both. Spawning a second Node
    // process would exercise the same property of the store at far
    // greater cost.
    //
    // This is the assertion that fails on the pre-step-44 memory store:
    // there, each app counts to 5 on its own and the 10th request still
    // succeeds.
    const windowMs = 15 * 60 * 1000;
    const options = {
      windowMs,
      limit: 5,
      prefix: "rl:test:instances:",
      failurePolicy: /** @type {const} */ ("open"),
      buildMessage: (/** @type {string} */ retryTime) => `Too many. Try again in ${retryTime}.`,
    };

    const instanceA = express().set("trust proxy", 1);
    instanceA.post("/x", createLimiter(options), (req, res) => res.status(200).json({ ok: true }));
    instanceA.use(errorHandler);

    const instanceB = express().set("trust proxy", 1);
    instanceB.post("/x", createLimiter(options), (req, res) => res.status(200).json({ ok: true }));
    instanceB.use(errorHandler);

    const ip = "203.0.113.44";
    const hit = (/** @type {import("express").Express} */ instance) =>
      request(instance).post("/x").set("X-Forwarded-For", ip);

    // Three on A, two on B: five in total, spread across the fleet.
    for (let i = 0; i < 3; i++) expect((await hit(instanceA)).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await hit(instanceB)).status).toBe(200);

    // The sixth is refused by BOTH, because the count is one count.
    expect((await hit(instanceB)).status).toBe(429);
    expect((await hit(instanceA)).status).toBe(429);
  });

  it("separates the buckets by prefix, so one IP's general count is not its auth count", async () => {
    // Without a per-limiter prefix the three limiters would increment the
    // same key for the same IP, and the tightest limit would silently
    // become the limit for everything.
    const ip = "203.0.113.55";
    for (let i = 0; i < 5; i++) {
      await request(testServer()).post("/api/v1/auth/login").set("X-Forwarded-For", ip).send({
        email: `nobody-${i}@example.com`,
        password: "not-the-right-password",
      });
    }
    // Auth is now at its cap for this IP.
    const capped = await request(testServer()).post("/api/v1/auth/login").set("X-Forwarded-For", ip).send({
      email: "nobody@example.com",
      password: "not-the-right-password",
    });
    expect(capped.status).toBe(429);

    // A read path from the same IP is untouched: different bucket.
    const read = await request(testServer()).get("/api/v1/documents").set("X-Forwarded-For", ip);
    expect(read.status).not.toBe(429);
  });
});

describe("FR-5.6 — when Redis is unavailable", () => {
  /**
   * The outage is produced by disconnecting the real client rather than by
   * stopping the shared container. The client ends up in exactly the state
   * a network failure puts it in — `enableOfflineQueue: false` means every
   * command rejects immediately — so the code under test sees the real
   * error, not a mock. Stopping the container would also change its port,
   * and config.js is a frozen singleton resolved once at import, so the
   * suite could never reconnect to it afterwards.
   */
  async function withRedisDown(/** @type {() => Promise<void>} */ body) {
    getRedis().disconnect();
    try {
      await body();
    } finally {
      await getRedis().connect().catch(() => {});
    }
  }

  it("refuses an analysis with 503 SERVER_BUSY — fail CLOSED, because it spends money", async () => {
    const { document, cookie } = await ownedDocument();

    await withRedisDown(async () => {
      const res = await analyze(document.id, cookie);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("SERVER_BUSY");
      // Not a 429: the client exceeded nothing. The server cannot tell
      // whether it should be allowed, and says so honestly.
      expect(res.status).not.toBe(429);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(res.body.error.requestId).toEqual(expect.any(String));
    });
  });

  it("still serves a read — fail OPEN, because an unmetered history page costs nothing", async () => {
    const { cookie } = await ownedDocument();

    await withRedisDown(async () => {
      const res = await request(testServer()).get("/api/v1/documents").set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.documents).toEqual(expect.any(Array));
    });
  });

  it("still lets a user sign in, the case FR-5.6 leaves open and PRD D13 decides", async () => {
    // FR-5.4 names what must survive a spend-ceiling degradation: "existing
    // reports, history, login, and deletion continue to work". Auth
    // therefore fails open, at the stated cost of no cross-request
    // brute-force ceiling while Redis is down — see the note on
    // authLimiter in middleware/rateLimits.js.
    const password = "correct-horse-battery";
    const user = await createUser({ password });

    await withRedisDown(async () => {
      const res = await request(testServer())
        .post("/api/v1/auth/login")
        .send({ email: user.email, password });
      expect(res.status).toBe(200);
    });
  });

  it("recovers on its own once Redis returns, with the limit enforced again", async () => {
    // An outage must not leave the limiter permanently open: that would
    // turn a transient failure into a standing one.
    const { document, cookie } = await ownedDocument();

    await withRedisDown(async () => {
      expect((await analyze(document.id, cookie)).status).toBe(503);
    });

    const after = await analyze(document.id, cookie);
    expect(after.status).not.toBe(503);
  });

  it("reports Redis as down in /api/ready while the API keeps serving reads", async () => {
    const { cookie } = await ownedDocument();

    await withRedisDown(async () => {
      const ready = await request(testServer()).get("/api/ready");
      expect(ready.status).toBe(503);
      expect(ready.body.checks.redis.ok).toBe(false);
      // The per-dependency breakdown (FR-4.7) is what distinguishes
      // "degraded" from "down" — Postgres is fine and reads still work.
      expect(ready.body.checks.postgres.ok).toBe(true);
      expect((await request(testServer()).get("/api/v1/documents").set("Cookie", cookie)).status).toBe(200);
    });
  });
});
