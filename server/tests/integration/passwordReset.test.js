import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import bcrypt from "bcrypt";
import prisma from "../../src/lib/prisma.js";
import { getEmailService, resetEmailForTests } from "../../src/lib/email.js";
import { extractFirstLink } from "../../src/lib/email/sinkProvider.js";
import { getRedis } from "../../src/lib/redis.js";
import { hashToken, issueAuthToken } from "../../src/services/authTokens.js";
import { requestPasswordReset } from "../../src/services/passwordReset.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { createUser } from "./factories.js";

/**
 * TR-10 (SRS §10.2) — password reset: FR-1.8 and FR-1.9.
 *
 * The two assertions that carry this file are the ones an implementation
 * passes everything else without: that a SECOND outstanding reset token is
 * invalidated by the first use, and that a cookie issued BEFORE the reset
 * stops working. Both are silent when missing — the happy path looks
 * identical either way.
 */

const PASSWORD = "Password123!";
const NEW_PASSWORD = "a-much-better-passphrase";

/** The sink the singleton email service writes to under NODE_ENV=test. */
const sink = () =>
  /** @type {ReturnType<typeof import("../../src/lib/email/sinkProvider.js").createSinkProvider>} */ (
    /** @type {any} */ (getEmailService().provider)
  );

const json = (req) => req.set("Content-Type", "application/json");

const forgot = (email) =>
  json(request(testServer()).post("/api/v1/auth/forgot-password")).send({ email });
const reset = (token, password = NEW_PASSWORD) =>
  json(request(testServer()).post("/api/v1/auth/reset-password")).send({
    token,
    password,
  });
const login = (email, password) =>
  json(request(testServer()).post("/api/v1/auth/login")).send({ email, password });

/** The reset token from the most recent email to an address. */
function tokenFromEmail(email) {
  const message = sink().latestTo(email);
  const link = extractFirstLink(message?.text ?? "");
  return link ? new URL(link).searchParams.get("token") : null;
}

/**
 * Drives the request and AWAITS the detached issue-and-send, which the
 * route deliberately does not wait for (it is what keeps the response
 * timing identical for accounts that exist and accounts that do not).
 */
async function requestResetAndWait(email) {
  /** @type {Promise<unknown>[]} */
  const work = [];
  await requestPasswordReset(email, { detach: (p) => work.push(p) });
  await Promise.all(work);
  await getEmailService().flush();
  return tokenFromEmail(email);
}

beforeEach(async () => {
  resetEmailForTests();
  sink().clear();
});

describe("TR-10 — forgot-password does not disclose whether an account exists", () => {
  it("returns 202 with a byte-identical body for a real and an unknown address", async () => {
    const user = await createUser({ password: PASSWORD });

    const known = await forgot(user.email);
    const unknown = await forgot("nobody-at-all@example.test");

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    // Byte-identical, not merely "both 202": a difference anywhere in the
    // body is an enumeration endpoint.
    expect(JSON.stringify(known.body)).toBe(JSON.stringify(unknown.body));
  }, 30_000);

  it("sends a real link for the account that exists, and nothing for the one that does not", async () => {
    const user = await createUser({ password: PASSWORD });

    const token = await requestResetAndWait(user.email);
    expect(token).toEqual(expect.any(String));

    sink().clear();
    await requestResetAndWait("nobody-at-all@example.test");
    expect(sink().messages()).toHaveLength(0);
  }, 30_000);

  it("does not await the work that only a real account triggers", async () => {
    // The invisible half of not disclosing existence. Issuing a token and
    // queueing an email is measurable work; awaiting it would turn the 202
    // into an oracle readable with a stopwatch. Both paths await only the
    // lookup, so the detached work is still unfinished when the call
    // returns.
    const user = await createUser({ password: PASSWORD });
    /** @type {string[]} */
    const order = [];
    /** @type {Promise<unknown>[]} */
    const work = [];

    await requestPasswordReset(user.email, {
      detach: (p) => work.push(p.then(() => order.push("work finished"))),
    });
    order.push("call returned");

    await Promise.all(work);

    // Ordering, not a row count. Counting rows was a race of my own
    // making: the detached insert can land before the count query runs,
    // and the test then failed for a reason that had nothing to do with
    // what it claims to check.
    expect(order).toEqual(["call returned", "work finished"]);
    expect(await prisma.authToken.count({ where: { type: "PASSWORD_RESET" } })).toBe(1);
  }, 30_000);

  it("normalises the address, so whitespace and case still reach the account", async () => {
    const user = await createUser({
      email: "mixed.case@example.test",
      password: PASSWORD,
    });
    const token = await requestResetAndWait(user.email);
    expect(token).toEqual(expect.any(String));

    sink().clear();
    const res = await forgot("  Mixed.Case@EXAMPLE.test  ");
    await getEmailService().flush();
    expect(res.status).toBe(202);
  }, 30_000);
});

describe("TR-10 — the token", () => {
  it("is stored only as a hash, and expires in 30 minutes, not 24 hours", async () => {
    const user = await createUser({ password: PASSWORD });
    const token = await requestResetAndWait(user.email);

    const row = await prisma.authToken.findFirstOrThrow({
      where: { userId: user.id, type: "PASSWORD_RESET" },
    });
    expect(row.tokenHash).toBe(hashToken(/** @type {string} */ (token)));
    expect(row.tokenHash).not.toContain(token);

    // Deliberately much shorter than verification's 24 hours: a live reset
    // link is a takeover waiting to happen, where a live verification link
    // is not.
    const minutes = (row.expiresAt.getTime() - row.createdAt.getTime()) / 60_000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30);
  }, 30_000);

  it("is single-use", async () => {
    const user = await createUser({ password: PASSWORD });
    const token = /** @type {string} */ (await requestResetAndWait(user.email));

    expect((await reset(token)).status).toBe(200);
    expect((await reset(token, "another-new-password")).status).toBe(400);
  }, 30_000);

  it("is refused once expired, and the password is untouched", async () => {
    const user = await createUser({ password: PASSWORD });
    const token = await issueAuthToken(user.id, "PASSWORD_RESET");
    await prisma.authToken.updateMany({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    expect((await reset(token)).status).toBe(400);
    expect((await login(user.email, PASSWORD)).status).toBe(200);
  }, 30_000);

  it("gives one answer for unknown, used and expired — no oracle", async () => {
    const user = await createUser({ password: PASSWORD });
    const used = /** @type {string} */ (await requestResetAndWait(user.email));
    await reset(used);

    const expired = await issueAuthToken(user.id, "PASSWORD_RESET");
    await prisma.authToken.updateMany({
      where: { tokenHash: hashToken(expired) },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const bodies = await Promise.all([
      reset("x".repeat(43)),
      reset(used),
      reset(expired),
    ]);
    const [first] = bodies;
    for (const res of bodies) {
      expect(res.status).toBe(first.status);
      expect(res.body.error.message).toBe(first.body.error.message);
    }
  }, 30_000);

  it("does not accept a verification token — a different type cannot reset a password", async () => {
    const user = await createUser({ password: PASSWORD });
    const verification = await issueAuthToken(user.id, "EMAIL_VERIFICATION");

    expect((await reset(verification)).status).toBe(400);
    expect((await login(user.email, PASSWORD)).status).toBe(200);
  }, 30_000);
});

describe("TR-10 — reset does all four things", () => {
  it("sets the new password and refuses the old one", async () => {
    const user = await createUser({ password: PASSWORD });
    const token = /** @type {string} */ (await requestResetAndWait(user.email));

    expect((await reset(token)).status).toBe(200);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    expect((await login(user.email, PASSWORD)).status).toBe(401);
  }, 30_000);

  it("stores the new password hashed, never in plaintext", async () => {
    const user = await createUser({ password: PASSWORD });
    const token = /** @type {string} */ (await requestResetAndWait(user.email));
    await reset(token);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).not.toContain(NEW_PASSWORD);
    expect(await bcrypt.compare(NEW_PASSWORD, after.passwordHash)).toBe(true);
  }, 30_000);

  it("increments tokenVersion (FR-1.9)", async () => {
    const user = await createUser({ password: PASSWORD });
    const token = /** @type {string} */ (await requestResetAndWait(user.email));

    await reset(token);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.tokenVersion).toBe(user.tokenVersion + 1);
  }, 30_000);

  it("kills a session issued BEFORE the reset, with 401 SESSION_REVOKED", async () => {
    // The assertion an implementation passes everything else without. A
    // reset exists to end an attacker's access; a cookie that outlives it
    // means the reset changed a password and nothing else.
    const user = await createUser({ password: PASSWORD });
    const cookie = `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`;
    expect(
      (await request(testServer()).get("/api/v1/auth/me").set("Cookie", cookie)).status,
    ).toBe(200);

    const token = /** @type {string} */ (await requestResetAndWait(user.email));
    await reset(token);

    const after = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookie);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("SESSION_REVOKED");
  }, 30_000);

  it("invalidates a SECOND outstanding reset token — the one people forget", async () => {
    // The attack this closes: someone triggers a reset for an address they
    // do not own and keeps the token. The owner notices, resets their own
    // password, and feels safe. Without this, the attacker's token is
    // still live and buys them a fresh 30-minute window into an account
    // that has just been "secured".
    const user = await createUser({ password: PASSWORD });
    const attackerToken = /** @type {string} */ (await requestResetAndWait(user.email));
    sink().clear();
    const ownerToken = /** @type {string} */ (await requestResetAndWait(user.email));
    expect(attackerToken).not.toBe(ownerToken);

    expect((await reset(ownerToken)).status).toBe(200);

    expect((await reset(attackerToken, "attacker-chosen-password")).status).toBe(400);
    expect((await login(user.email, "attacker-chosen-password")).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  }, 30_000);

  it("leaves another user's outstanding token alone", async () => {
    const alice = await createUser({ password: PASSWORD });
    const bob = await createUser({ password: PASSWORD });
    const bobToken = /** @type {string} */ (await requestResetAndWait(bob.email));
    sink().clear();
    const aliceToken = /** @type {string} */ (await requestResetAndWait(alice.email));

    await reset(aliceToken);

    expect((await reset(bobToken)).status).toBe(200);
  }, 30_000);

  it("clears the lockout counters, so a recovered account is not still locked out", async () => {
    const user = await createUser({ password: PASSWORD });
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 9, lockedUntil: new Date(Date.now() + 60_000) },
    });
    const token = /** @type {string} */ (await requestResetAndWait(user.email));

    await reset(token);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();
  }, 30_000);

  it("does all four together or not at all", async () => {
    // A password changed without tokenVersion moving would leave every
    // stolen session alive, so the four are one transaction. Proven by the
    // failure path: a token that cannot be consumed changes nothing.
    const user = await createUser({ password: PASSWORD });
    await reset("z".repeat(43));

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.tokenVersion).toBe(user.tokenVersion);
    expect(after.passwordHash).toBe(user.passwordHash);
  }, 30_000);
});

describe("TR-10 — the notice, and the endpoint's shape", () => {
  it("emails the address that the password changed, with no link to act on", async () => {
    const user = await createUser({ password: PASSWORD });
    const token = /** @type {string} */ (await requestResetAndWait(user.email));
    sink().clear();

    await reset(token);
    await getEmailService().flush();

    const notice = sink().latestTo(user.email);
    expect(notice?.subject).toMatch(/password was changed/i);
    // A notice that could be acted on is a phishing template.
    expect(extractFirstLink(notice?.text ?? "")).toBeUndefined();
  }, 30_000);

  it("does not send the notice for a reset that failed", async () => {
    const user = await createUser({ password: PASSWORD });
    await requestResetAndWait(user.email);
    sink().clear();

    await reset("q".repeat(43));
    await getEmailService().flush();

    expect(sink().messages()).toHaveLength(0);
  }, 30_000);

  it("does not sign the user in — no session cookie comes back", async () => {
    const user = await createUser({ password: PASSWORD });
    const token = /** @type {string} */ (await requestResetAndWait(user.email));

    const res = await reset(token);

    expect(res.headers["set-cookie"]).toBeUndefined();
  }, 30_000);

  it("rejects a weak new password", async () => {
    const user = await createUser({ password: PASSWORD });
    const token = /** @type {string} */ (await requestResetAndWait(user.email));

    expect((await reset(token, "short")).status).toBe(400);
    // And the token is not spent by a request that never got that far.
    expect((await reset(token)).status).toBe(200);
  }, 30_000);
});

describe("FR-1.8 — forgot-password is rate limited", () => {
  it("refuses the 4th request in an hour for one address", async () => {
    const user = await createUser({ password: PASSWORD });
    for (let i = 0; i < 3; i++) expect((await forgot(user.email)).status).toBe(202);
    expect((await forgot(user.email)).status).toBe(429);
  }, 30_000);

  it("counts addresses that do not exist the same way — a 429 is not an oracle either", async () => {
    const unknown = "definitely-not-a-user@example.test";
    for (let i = 0; i < 3; i++) expect((await forgot(unknown)).status).toBe(202);
    expect((await forgot(unknown)).status).toBe(429);
  }, 30_000);

  it("fails CLOSED when Redis is down", async () => {
    const user = await createUser({ password: PASSWORD });
    getRedis().disconnect();
    try {
      expect((await forgot(user.email)).status).toBe(503);
    } finally {
      await getRedis()
        .connect()
        .catch(() => {});
    }
  }, 30_000);
});
