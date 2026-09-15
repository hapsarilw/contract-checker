import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../src/app.js";
import { countWords } from "../../src/services/extraction.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { createDocument, createUser } from "./factories.js";

/**
 * BUILD-PLAN step 41 (OPS-2) / NFR-2.6 — the two scenarios this step's
 * own instructions name explicitly, run against the REAL app (real
 * routes, real requireAuth, the real generalLimiter/authLimiter/
 * analyzeLimiter mounted exactly where app.js/auth.js/documents.js
 * mount them), not the isolated bare-Express app
 * tests/unit/rateLimits.test.js uses to exercise the limiter logic
 * itself. This file is checking the WIRING; that one is checking the
 * COUNTING.
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
  const req = request(app)
    .post(`/api/v1/documents/${documentId}/analyze`)
    .set("Cookie", cookie)
    .set("Content-Type", "application/json");
  return forwardedFor ? req.set("X-Forwarded-For", forwardedFor) : req;
}

describe("auth rate limiting on the real routes (NFR-2.6: 5 / 15 min / IP)", () => {
  it("the 6th auth attempt in a window returns 429 RATE_LIMITED, with Retry-After and a retry time in the message", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "nobody@example.test", password: "wrong-password-entirely" });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app)
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
      await request(app)
        .post("/api/v1/auth/register")
        .send({
          email: `combined-${i}@example.test`,
          password: "long-enough-password-1",
        });
    }
    for (let i = 0; i < 2; i++) {
      await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "combined-0@example.test", password: "wrong" });
    }

    const blocked = await request(app)
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
