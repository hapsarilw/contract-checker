import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
import app from "../../src/app.js";
import prisma from "../../src/lib/prisma.js";
import { getRedis } from "../../src/lib/redis.js";
import { getEmailService } from "../../src/lib/email.js";
import { extractFirstLink } from "../../src/lib/email/sinkProvider.js";
import { countWords } from "../../src/services/extraction.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { consumeAuthToken, issueAuthToken, TOKEN_TTL_MS } from "../../src/services/authTokens.js";
import { sendVerificationEmail } from "../../src/services/emailVerification.js";
import { getLlmProvider } from "../../src/services/llm/index.js";
import { createDocument, createUser } from "./factories.js";

/**
 * TR-9 (SRS §10.2) — email verification: FR-1.7, PRD §8.1, decision D4.
 *
 * The property under test is as much WHAT STILL WORKS as what is refused.
 * An unverified account is meant to sign in, browse and upload; only
 * analysis is gated. A test suite that only proved the 403 would pass an
 * implementation that had locked the door instead.
 */

const CONTRACT = [
  "SERVICES AGREEMENT",
  "1. Payment. Client shall pay each invoice within thirty (30) days.",
  "2. Term. Either party may terminate on thirty (30) days' notice.",
].join("\n\n");

/** The sink the singleton email service is writing to under NODE_ENV=test. */
const sink = () => /** @type {ReturnType<typeof import("../../src/lib/email/sinkProvider.js").createSinkProvider>} */ (
  /** @type {any} */ (getEmailService().provider)
);

// Imported as a TYPE, not a value: eslint's no-unused-vars does not read
// JSDoc casts and reported the value import as unused, but tsc needs the
// name. An inline import type satisfies both.
const mock = () =>
  /** @type {import("../../src/services/llm/mockProvider.js").MockLlmProvider} */ (getLlmProvider().backend);

const json = (req) => req.set("Content-Type", "application/json");

async function unverifiedUser() {
  const user = await createUser({ state: "UNVERIFIED" });
  const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });
  return { user, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

/** The plaintext token from the most recent message to an address. */
async function tokenSentTo(address) {
  await getEmailService().flush();
  const link = extractFirstLink(sink().latestTo(address)?.text ?? "");
  return link ? new URL(link).searchParams.get("token") : null;
}

const verify = (token) => json(request(app).post("/api/v1/auth/verify-email")).send({ token });

beforeEach(() => {
  sink().clear();
});

describe("TR-9 — registration", () => {
  it("creates an UNVERIFIED user and emails a verification link", async () => {
    const res = await json(request(app).post("/api/v1/auth/register")).send({
      email: "newcomer@example.test",
      password: "correct-horse-battery",
    });

    expect(res.status).toBe(201);
    expect(res.body.user.state).toBe("UNVERIFIED");

    const token = await tokenSentTo("newcomer@example.test");
    expect(token).toBeTruthy();
    expect(sink().latestTo("newcomer@example.test")?.subject).toMatch(/confirm/i);
  });

  it("stores only a hash, never the plaintext token, and expires it in 24 hours", async () => {
    await json(request(app).post("/api/v1/auth/register")).send({
      email: "hashed@example.test",
      password: "correct-horse-battery",
    });
    const token = /** @type {string} */ (await tokenSentTo("hashed@example.test"));

    const rows = await prisma.authToken.findMany({ where: { user: { email: "hashed@example.test" } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("EMAIL_VERIFICATION");
    expect(rows[0].tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    // The plaintext is nowhere in the table.
    expect(rows[0].tokenHash).not.toContain(token);
    expect(await prisma.authToken.count({ where: { tokenHash: token } })).toBe(0);

    const ttl = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
    expect(Math.abs(ttl - TOKEN_TTL_MS.EMAIL_VERIFICATION)).toBeLessThan(5_000);
  });

  it("issues a 32-byte token", async () => {
    await json(request(app).post("/api/v1/auth/register")).send({
      email: "bytes@example.test",
      password: "correct-horse-battery",
    });
    const token = /** @type {string} */ (await tokenSentTo("bytes@example.test"));
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("still registers the user when the token cannot be issued (NFR-3.8)", async () => {
    // A real database failure, not a mock: a user id that does not exist
    // violates the foreign key, so issuing the token rejects. Registration
    // has already succeeded by then, so this must not throw.
    await expect(sendVerificationEmail({ id: "no-such-user", email: "ghost@example.test" })).resolves.toEqual({
      queued: false,
    });
  });
});

describe("TR-9 — analysis is gated, and only analysis", () => {
  it("returns 403 EMAIL_NOT_VERIFIED from analyze, naming the fix", async () => {
    const { user, cookie } = await unverifiedUser();
    const document = await createDocument({ userId: user.id, rawText: CONTRACT, wordCount: countWords(CONTRACT) });

    const res = await json(request(app).post(`/api/v1/documents/${document.id}/analyze`).set("Cookie", cookie));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("EMAIL_NOT_VERIFIED");
    expect(res.body.error.message).toMatch(/verification/i);
    expect(res.body.error.message).toContain("/api/v1/auth/resend-verification");
    // Refused before any spend.
    expect(mock().calls).toHaveLength(0);
    expect(await prisma.analysis.count({ where: { documentId: document.id } })).toBe(0);
  });

  it("checks ownership FIRST, so verification state cannot be used to probe another user's documents", async () => {
    const { cookie } = await unverifiedUser();
    const other = await createUser();
    const foreign = await createDocument({ userId: other.id, rawText: CONTRACT, wordCount: countWords(CONTRACT) });

    const res = await json(request(app).post(`/api/v1/documents/${foreign.id}/analyze`).set("Cookie", cookie));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("lets an UNVERIFIED user sign in, browse, upload, read and delete — the gate is analysis, not the door", async () => {
    const password = "correct-horse-battery";
    const user = await createUser({ state: "UNVERIFIED", password });

    const login = await json(request(app).post("/api/v1/auth/login")).send({ email: user.email, password });
    expect(login.status).toBe(200);
    expect(login.body.user.state).toBe("UNVERIFIED");
    const cookie = login.headers["set-cookie"][0].split(";")[0];

    expect((await request(app).get("/api/v1/auth/me").set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).get("/api/v1/documents").set("Cookie", cookie)).status).toBe(200);

    const words = Array.from({ length: 300 }, (_unused, i) => `clause${i}`).join(" ");
    const created = await json(request(app).post("/api/v1/documents").set("Cookie", cookie)).send({ text: words });
    expect(created.status).toBe(201);

    const id = created.body.document.id;
    expect((await request(app).get(`/api/v1/documents/${id}`).set("Cookie", cookie)).status).toBe(200);
    expect((await json(request(app).delete(`/api/v1/documents/${id}`).set("Cookie", cookie))).status).toBe(200);
  }, 60_000);
});

describe("TR-9 — consuming the token", () => {
  async function registered(email = "consume@example.test") {
    await json(request(app).post("/api/v1/auth/register")).send({ email, password: "correct-horse-battery" });
    const token = /** @type {string} */ (await tokenSentTo(email));
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { token, user };
  }

  it("activates the account, after which analysis is allowed", async () => {
    const { token, user } = await registered();

    const res = await verify(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.state).toBe("ACTIVE");
    expect(after.emailVerifiedAt).toBeInstanceOf(Date);

    const cookie = `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`;
    const document = await createDocument({ userId: user.id, rawText: CONTRACT, wordCount: countWords(CONTRACT) });
    mock().scriptValidResponse({ overall_risk: "low", findings: [] });
    expect((await json(request(app).post(`/api/v1/documents/${document.id}/analyze`).set("Cookie", cookie))).status).toBe(200);
  });

  it("is single-use: the same token is refused the second time", async () => {
    const { token } = await registered();
    expect((await verify(token)).status).toBe(200);

    const again = await verify(token);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("is single-use even while another transaction holds the token uncommitted", async () => {
    // DETERMINISTIC, because the HTTP-level race below cannot be trusted
    // to fail. A real check-then-act implementation ("find an unused
    // token, then mark it used") passed that test three runs out of three:
    // the window is a few milliseconds and a request finishes it before
    // its neighbours begin. So the mechanism is proven by holding the
    // window open instead of hoping to land in it.
    //
    // Transaction A consumes the token and waits before committing. B then
    // tries the same token. With one conditional UPDATE, B blocks on A's
    // row lock, and when A commits B's WHERE (usedAt IS NULL) no longer
    // matches — B loses. With find-then-update, B's find (which takes no
    // lock) still sees the token as unused, and B wins too.
    const { token } = await registered("held@example.test");

    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    /** @type {() => void} */
    let consumed = () => {};
    const aConsumed = new Promise((resolve) => (consumed = () => resolve(undefined)));

    const a = prisma.$transaction(async (tx) => {
      await consumeAuthToken(tx, token, "EMAIL_VERIFICATION");
      consumed();
      await held;
    });
    await aConsumed;

    const b = prisma
      .$transaction((tx) => consumeAuthToken(tx, token, "EMAIL_VERIFICATION"))
      .then(() => "won", () => "lost");
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await a;

    expect(await b).toBe("lost");
  }, 30_000);

  it("of many simultaneous requests, exactly one wins (an outcome check, not a proof)", async () => {
    // Kept as an end-to-end statement of the requirement. It CANNOT catch a
    // check-then-act implementation on its own — see the test above, which
    // exists because this one passed against exactly that.
    const { token } = await registered("racy@example.test");
    const results = await Promise.all(Array.from({ length: 8 }, () => verify(token)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(7);
  });

  it("rejects an expired token and leaves the account UNVERIFIED", async () => {
    const { token, user } = await registered();
    await prisma.authToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });

    const res = await verify(token);

    expect(res.status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).state).toBe("UNVERIFIED");
  });

  it("gives one answer for unknown, used and expired, so the response is not an oracle", async () => {
    const { token, user } = await registered();
    await verify(token);
    const used = await verify(token);
    const unknown = await verify("A".repeat(43));
    await prisma.authToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(0), usedAt: null } });
    const expired = await verify(token);

    expect(new Set([used.body.error.message, unknown.body.error.message, expired.body.error.message]).size).toBe(1);
  });

  it("does not accept a token of another type — a password-reset token cannot verify an email", async () => {
    const user = await createUser({ state: "UNVERIFIED" });
    const resetToken = await issueAuthToken(user.id, "PASSWORD_RESET");

    expect((await verify(resetToken)).status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).state).toBe("UNVERIFIED");
  });

  it("does not un-suspend a suspended account that opens an old verification link", async () => {
    // Proving control of a mailbox is not a reason to lift a suspension.
    const user = await createUser({ state: "SUSPENDED" });
    const token = await issueAuthToken(user.id, "EMAIL_VERIFICATION");

    expect((await verify(token)).status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.state).toBe("SUSPENDED");
    expect(after.emailVerifiedAt).toBeInstanceOf(Date); // the address WAS verified
  });

  it("spends every other outstanding verification link once one is used", async () => {
    const { token, user } = await registered();
    const second = await issueAuthToken(user.id, "EMAIL_VERIFICATION");

    await verify(token);

    expect((await verify(second)).status).toBe(400);
  });

  it("rejects a malformed body with 400, without touching the database", async () => {
    expect((await json(request(app).post("/api/v1/auth/verify-email")).send({})).status).toBe(400);
    expect((await json(request(app).post("/api/v1/auth/verify-email")).send({ token: "short" })).status).toBe(400);
    expect((await json(request(app).post("/api/v1/auth/verify-email")).send({ token: "x".repeat(5000) })).status).toBe(400);
  });

  it("is a POST: a GET on the same path does not consume the token", async () => {
    // Email scanners open every link in a message. If a GET consumed the
    // token, the scanner would spend it before the person saw the email.
    const { token, user } = await registered("scanner@example.test");

    const res = await request(app).get(`/api/v1/auth/verify-email?token=${token}`);

    expect(res.status).toBe(404);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).state).toBe("UNVERIFIED");
  });
});

describe("FR-1.7 — resend, 3 an hour per account and 10 an hour per IP", () => {
  const resend = (cookie, ip) => {
    const req = json(request(app).post("/api/v1/auth/resend-verification").set("Cookie", cookie));
    return ip ? req.set("X-Forwarded-For", ip) : req;
  };

  it("requires a signed-in user", async () => {
    expect((await json(request(app).post("/api/v1/auth/resend-verification"))).status).toBe(401);
  });

  it("sends a fresh email with a working token", async () => {
    const { user, cookie } = await unverifiedUser();

    const res = await resend(cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, alreadyVerified: false });
    const token = await tokenSentTo(user.email);
    expect(token).toBeTruthy();
    expect((await verify(/** @type {string} */ (token))).status).toBe(200);
  });

  it("sends nothing to an already-verified account, and says so", async () => {
    const user = await createUser({ state: "ACTIVE" });
    const cookie = `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`;

    const res = await resend(cookie);

    expect(res.body).toEqual({ sent: false, alreadyVerified: true });
    await getEmailService().flush();
    expect(sink().messages()).toHaveLength(0);
  });

  it("refuses the 4th request in an hour for one account with RATE_LIMITED", async () => {
    const { cookie } = await unverifiedUser();

    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await resend(cookie, `198.51.100.${i + 1}`)).status);

    // Different IPs each time, so only the ACCOUNT limit can be speaking.
    expect(statuses).toEqual([200, 200, 200, 429]);
    await getEmailService().flush();
    expect(sink().messages()).toHaveLength(3);
  });

  it("refuses the 11th request in an hour from one IP, across different accounts", async () => {
    const ip = "203.0.113.77";
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const { cookie } = await unverifiedUser();
      statuses.push((await resend(cookie, ip)).status);
    }
    // Every account is on its first request, so only the IP limit can be
    // speaking.
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  }, 60_000);

  it("fails CLOSED when Redis is down: an unmetered resend is an abuse vector against a third party", async () => {
    const { cookie } = await unverifiedUser();

    getRedis().disconnect();
    try {
      const res = await resend(cookie);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("SERVER_BUSY");
    } finally {
      await getRedis().connect().catch(() => {});
    }
    await getEmailService().flush();
    expect(sink().messages()).toHaveLength(0);
  });
});
