import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import {
  authLimiter,
  analyzeLimiter,
  generalLimiter,
  resetRateLimitsForTests,
} from "../../src/middleware/rateLimits.js";

/**
 * BUILD-PLAN step 41 (OPS-2) / NFR-2.6.
 *
 * A bare Express app, not server/src/app.js — these three limiters are
 * MODULE-LEVEL SINGLETONS, so this file exercises the real
 * counting/keying/messaging logic directly, without Postgres, bcrypt or
 * session signing. tests/integration/rateLimits.test.js proves the same
 * limits are correctly WIRED onto the real routes (through requireAuth,
 * with the real login/analyze flow) — this file and that one check
 * different things, not the same thing twice.
 *
 * MOVED FROM tests/unit/ AT STEP 44, and the move is the point rather
 * than housekeeping. These assertions are about what a limiter COUNTS,
 * and since step 44 the counting happens in Redis. §10 defines a unit
 * test as one with no database, no network and no container; a test of
 * counting that needs a live store no longer qualifies, whatever
 * directory it sits in. Leaving it under unit/ would have been worse than
 * cosmetic: a developer with docker-compose up would see it pass while
 * CI's unit job — which starts no containers — saw it fail, which is the
 * shape of bug that costs an afternoon.
 *
 * What genuinely remains unit-testable is the failure POLICY, which is
 * pure: tests/unit/failurePolicyStore.test.js covers FR-5.6 with a fake
 * store that throws on command.
 */
function buildApp() {
  const app = express();
  // Mirrors app.js's own `trust proxy` setting (step 6) — required for
  // Express's own `request.ip` (what the IP-keyed limiters read) to
  // honour X-Forwarded-For at all, and for the keying test below to mean
  // anything.
  app.set("trust proxy", 1);

  app.get("/general", generalLimiter, (req, res) => res.status(200).json({ ok: true }));
  app.post("/auth", authLimiter, (req, res) => res.status(200).json({ ok: true }));
  app.post(
    "/analyze",
    // Standing in for requireAuth (documents.js mounts analyzeLimiter
    // after the real one) — just enough to give analyzeLimiter's
    // keyGenerator the req.auth.userId it reads.
    (req, res, next) => {
      req.auth = {
        userId: /** @type {string} */ (req.headers["x-test-user"] ?? "user-a"),
      };
      next();
    },
    analyzeLimiter,
    (req, res) => res.status(200).json({ ok: true }),
  );
  app.use(errorHandler);
  return app;
}

describe("rate limiters (BUILD-PLAN step 41, NFR-2.6)", () => {
  /** @type {import("express").Express} */
  let app;

  beforeEach(async () => {
    await resetRateLimitsForTests();
    app = buildApp();
  });

  it("allows exactly 5 auth attempts per IP per window, then 429s the 6th", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post("/auth")).status).toBe(200);
    }
    const res = await request(app).post("/auth");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });

  it("allows exactly 100 general requests per IP per window, then 429s the 101st", async () => {
    for (let i = 0; i < 100; i++) {
      expect((await request(app).get("/general")).status).toBe(200);
    }
    const res = await request(app).get("/general");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  }, 20_000);

  it("allows exactly 10 analyses per user per hour, then 429s the 11th", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/analyze").set("X-Test-User", "user-a");
      expect(res.status).toBe(200);
    }
    const res = await request(app).post("/analyze").set("X-Test-User", "user-a");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });

  it("keys the analyze limiter by user, not IP: varying the IP never resets or splits the same user's count", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/analyze")
        .set("X-Test-User", "user-a")
        .set("X-Forwarded-For", `198.51.100.${i}`); // a different IP on every single request
      expect(res.status).toBe(200);
    }
    const blocked = await request(app)
      .post("/analyze")
      .set("X-Test-User", "user-a")
      .set("X-Forwarded-For", "203.0.113.99"); // yet another, never-seen-before IP
    expect(blocked.status).toBe(429);
  });

  it("gives a different user their own, independent bucket", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app).post("/analyze").set("X-Test-User", "user-a");
    }
    expect(
      (await request(app).post("/analyze").set("X-Test-User", "user-a")).status,
    ).toBe(429);

    const otherUser = await request(app).post("/analyze").set("X-Test-User", "user-b");
    expect(otherUser.status).toBe(200);
  });

  it("keys the IP-based limiters on the real client address (trust proxy), not the proxy's own", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post("/auth").set("X-Forwarded-For", "203.0.113.5");
    }
    const blocked = await request(app)
      .post("/auth")
      .set("X-Forwarded-For", "203.0.113.5");
    expect(blocked.status).toBe(429);

    // A different declared client IP, same test process (same "proxy" as
    // far as the raw TCP connection is concerned) — a limiter that
    // (incorrectly) keyed on the connecting socket address instead of
    // X-Forwarded-For would treat this as the SAME client and stay
    // blocked; keying on the real client address gives it a fresh bucket.
    const freshIp = await request(app)
      .post("/auth")
      .set("X-Forwarded-For", "203.0.113.9");
    expect(freshIp.status).toBe(200);
  });

  it("a 429 carries a Retry-After header and a message stating a retry time", async () => {
    for (let i = 0; i < 5; i++) await request(app).post("/auth");
    const res = await request(app).post("/auth");

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    const seconds = Number(res.headers["retry-after"]);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(15 * 60);
    expect(res.body.error.message).toMatch(/in about \d+ (second|minute)s?/);
  });

  it("resetRateLimitsForTests() clears every limiter's counters — what tests/integration/setup.js relies on", async () => {
    for (let i = 0; i < 5; i++) await request(app).post("/auth");
    expect((await request(app).post("/auth")).status).toBe(429);

    await resetRateLimitsForTests();

    expect((await request(app).post("/auth")).status).toBe(200);
  });
});
