import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { getRedis } from "../../src/lib/redis.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { createUser } from "./factories.js";

/**
 * FR-3.15 — Idempotency-Key on POST /api/v1/documents, through the real
 * route and the real Redis. Analyze needs no equivalent tests: FR-3.8's
 * partial unique index already covers it (TR-8, analyze.test.js).
 */

async function signedIn() {
  const user = await createUser();
  const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });
  return { user, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

/** n whitespace-separated tokens — matches intake.test.js's convention, long enough to clear FR-2.5's minimum. */
const wordsOfLength = (n) => Array(n).fill("word").join(" ");

/** @param {string} cookie @param {{ key?: string, text?: string }} [options] */
function create(cookie, { key, text } = {}) {
  const req = request(testServer())
    .post("/api/v1/documents")
    .set("Cookie", cookie)
    .set("Content-Type", "application/json");
  if (key !== undefined) req.set("Idempotency-Key", key);
  return req.send({ text: text ?? wordsOfLength(250) });
}

describe("FR-3.15 — idempotent document creation", () => {
  it("a repeated key creates exactly one document and returns identical bodies", async () => {
    const { user, cookie } = await signedIn();
    const key = "retry-after-timeout-1";

    const first = await create(cookie, { key });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const second = await create(cookie, { key });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body).toEqual(first.body);

    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(1);
  });

  it("replays the ORIGINAL response, ignoring what the repeat itself would have created", async () => {
    // The strong form of "identical bodies": if the second request were
    // independently processed, a different word count would produce a
    // different response. It must not — the cached response from the
    // FIRST request is what comes back, unexamined.
    const { cookie } = await signedIn();
    const key = "retry-with-different-text";

    const first = await create(cookie, { key, text: wordsOfLength(250) });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.document.wordCount).toBe(250);

    const second = await create(cookie, { key, text: wordsOfLength(999) });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.body.document.wordCount).toBe(250);
  });

  it("replays even when the repeat's own body would fail validation", async () => {
    // Proves the cache check runs BEFORE multer and BEFORE schema
    // validation, not merely before the database write — a request whose
    // body could never succeed on its own still gets the original 201.
    const { cookie } = await signedIn();
    const key = "retry-with-garbage-body";

    const first = await create(cookie, { key });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const second = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", key)
      .send({ notText: "this would be VALIDATION_ERROR on its own" });

    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it("scopes the key per user — the same key string from a different account is a different key", async () => {
    const alice = await signedIn();
    const bob = await signedIn();
    const key = "shared-literal-string";

    const aliceRes = await create(alice.cookie, { key });
    const bobRes = await create(bob.cookie, { key });

    expect(aliceRes.status, JSON.stringify(aliceRes.body)).toBe(201);
    expect(bobRes.status, JSON.stringify(bobRes.body)).toBe(201);
    expect(bobRes.body.document.id).not.toBe(aliceRes.body.document.id);

    expect(await prisma.document.count({ where: { userId: alice.user.id } })).toBe(1);
    expect(await prisma.document.count({ where: { userId: bob.user.id } })).toBe(1);
  });

  it("frees the key after it expires, rather than remembering it forever", async () => {
    const { user, cookie } = await signedIn();
    const key = "expiring-key";

    const first = await create(cookie, { key });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // Shrinks the 24-hour TTL storeIdempotentResponse just set, rather
    // than waiting a day, on the exact key the route itself computes
    // (userId + the header value) — the same convention quota.test.js
    // uses to reach into Redis for a time-based assertion.
    await getRedis().pexpire(`idem:documents:${user.id}:${key}`, 5);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await create(cookie, { key });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.document.id).not.toBe(first.body.document.id);

    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(2);
  });

  it("a request with no key behaves exactly as before — two calls create two documents", async () => {
    const { user, cookie } = await signedIn();

    const first = await create(cookie);
    const second = await create(cookie);

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.document.id).not.toBe(first.body.document.id);
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(2);
  });

  it("treats a blank Idempotency-Key the same as no key at all", async () => {
    const { user, cookie } = await signedIn();

    const first = await create(cookie, { key: "" });
    const second = await create(cookie, { key: "" });

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.document.id).not.toBe(first.body.document.id);
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(2);
  });

  it("treats an unreasonably long Idempotency-Key the same as no key, rather than using it as a Redis key", async () => {
    const { user, cookie } = await signedIn();
    const tooLong = "x".repeat(300);

    const first = await create(cookie, { key: tooLong });
    const second = await create(cookie, { key: tooLong });

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.document.id).not.toBe(first.body.document.id);
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(2);
  });
});
