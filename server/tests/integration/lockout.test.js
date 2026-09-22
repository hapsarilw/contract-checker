import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { resetRateLimitsForTests } from "../../src/middleware/rateLimits.js";
import {
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  WINDOW_MS,
  recordFailedLogin,
} from "../../src/services/lockout.js";
import { createUser } from "./factories.js";

/**
 * TR-11 (SRS §10.2) — account lockout (FR-1.10) and the breached-password
 * check (FR-1.2).
 *
 * THE TEST DESIGN IS THE POINT HERE. NFR-2.6's per-IP limiter already
 * refuses the 6th auth attempt from one address, so ten failures and a
 * locked eleventh from the SAME IP would pass against an implementation
 * with no lockout at all — the limiter would be answering. Every lockout
 * assertion below therefore spreads the failures across addresses and
 * makes the locked attempt from an address that has made no attempts.
 */

const PASSWORD = "a-perfectly-fine-passphrase";
const WRONG = "definitely-not-the-password";

const json = (req) => req.set("Content-Type", "application/json");
const login = (email, password, ip) =>
  json(request(testServer()).post("/api/v1/auth/login")).set("X-Forwarded-For", ip).send({ email, password });
const register = (email, password, ip = "198.51.100.1") =>
  json(request(testServer()).post("/api/v1/auth/register")).set("X-Forwarded-For", ip).send({ email, password });

/** Ten failures, each from its own address, so no per-IP limiter fires. */
async function failFromManyIps(email, attempts = MAX_FAILED_ATTEMPTS) {
  for (let i = 0; i < attempts; i++) {
    const res = await login(email, WRONG, `203.0.113.${i + 1}`);
    // Every one of these must be the ordinary credentials failure. A 429
    // here would mean a limiter answered and the test below proves nothing.
    expect(res.status).toBe(401);
  }
}

describe("TR-11 — lockout is per ACCOUNT, not per IP (FR-1.10)", () => {
  it("locks after 10 failures spread across 10 addresses, and refuses an 11th from a fresh address", async () => {
    await resetRateLimitsForTests();
    const user = await createUser({ password: PASSWORD });

    await failFromManyIps(user.email);

    // An address that has made no attempt at all. Only an account-scoped
    // control can refuse this one.
    const locked = await login(user.email, WRONG, "198.51.100.77");
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
  }, 60_000);

  it("refuses the CORRECT password while locked — it is the account that is shut, not the guess", async () => {
    await resetRateLimitsForTests();
    const user = await createUser({ password: PASSWORD });
    await failFromManyIps(user.email);

    const res = await login(user.email, PASSWORD, "198.51.100.78");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("ACCOUNT_LOCKED");
  }, 60_000);

  it("states a retry time, in the message and in Retry-After", async () => {
    await resetRateLimitsForTests();
    const user = await createUser({ password: PASSWORD });
    await failFromManyIps(user.email);

    const res = await login(user.email, WRONG, "198.51.100.79");
    expect(res.body.error.message).toMatch(/try again in about \d+ minutes|about a minute/i);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(LOCKOUT_MS / 1000);
  }, 60_000);

  it("does not lock at 9 — the threshold is a ceiling, not an off-by-one", async () => {
    await resetRateLimitsForTests();
    const user = await createUser({ password: PASSWORD });
    await failFromManyIps(user.email, MAX_FAILED_ATTEMPTS - 1);

    expect((await login(user.email, PASSWORD, "198.51.100.80")).status).toBe(200);
  }, 60_000);

  it("locks one account without touching another", async () => {
    await resetRateLimitsForTests();
    const victim = await createUser({ password: PASSWORD });
    const bystander = await createUser({ password: PASSWORD });
    await failFromManyIps(victim.email);

    expect((await login(victim.email, PASSWORD, "198.51.100.81")).status).toBe(429);
    expect((await login(bystander.email, PASSWORD, "198.51.100.81")).status).toBe(200);
  }, 60_000);
});

describe("TR-11 — the counter resets, and the lock expires on its own", () => {
  it("a successful login clears the counter", async () => {
    await resetRateLimitsForTests();
    const user = await createUser({ password: PASSWORD });
    await failFromManyIps(user.email, MAX_FAILED_ATTEMPTS - 1);

    expect((await login(user.email, PASSWORD, "198.51.100.82")).status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.failedLoginCount).toBe(0);
    expect(after.firstFailedLoginAt).toBeNull();
    expect(after.lockedUntil).toBeNull();
  }, 60_000);

  it("nine failures, a success, then nine more do NOT lock — 'consecutive' means consecutive", async () => {
    await resetRateLimitsForTests();
    const user = await createUser({ password: PASSWORD });

    await failFromManyIps(user.email, MAX_FAILED_ATTEMPTS - 1);
    expect((await login(user.email, PASSWORD, "198.51.100.83")).status).toBe(200);
    await resetRateLimitsForTests();
    await failFromManyIps(user.email, MAX_FAILED_ATTEMPTS - 1);

    expect((await login(user.email, PASSWORD, "198.51.100.84")).status).toBe(200);
  }, 60_000);

  it("unlocks automatically once the window passes — no support ticket (PRD §8.1)", async () => {
    // A lockout that needs a human to clear it turns a failed attack into
    // a successful denial of service, with the victim in a queue.
    await resetRateLimitsForTests();
    const user = await createUser({ password: PASSWORD });
    await failFromManyIps(user.email);
    expect((await login(user.email, PASSWORD, "198.51.100.85")).status).toBe(429);

    // Wind the clock back rather than waiting fifteen minutes.
    await prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: new Date(Date.now() - 1_000) },
    });

    expect((await login(user.email, PASSWORD, "198.51.100.86")).status).toBe(200);
  }, 60_000);

  it("restarts the window when the previous failures have gone stale", async () => {
    // Ten typos spread over a year are not an attack. Counting them as one
    // hands an attacker a slow denial of service against a real user.
    const user = await createUser({ password: PASSWORD });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) await recordFailedLogin(user.id);

    const stale = new Date(Date.now() - WINDOW_MS - 60_000);
    await prisma.user.update({ where: { id: user.id }, data: { firstFailedLoginAt: stale } });

    const { locked } = await recordFailedLogin(user.id);
    expect(locked).toBe(false);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.failedLoginCount).toBe(1);
    expect(after.lockedUntil).toBeNull();
  }, 60_000);

  it("counts concurrent failures without losing any (no read-then-write race)", async () => {
    // A distributed attack IS the simultaneous case. Ten parallel guesses
    // that each read the same count and write count+1 would leave the
    // account at 1 with ten attempts spent.
    const user = await createUser({ password: PASSWORD });

    await Promise.all(Array.from({ length: MAX_FAILED_ATTEMPTS }, () => recordFailedLogin(user.id)));

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.failedLoginCount).toBe(MAX_FAILED_ATTEMPTS);
    expect(after.lockedUntil).not.toBeNull();
  }, 60_000);
});

describe("TR-11 — an unknown address is not treated as an account (FR-1.6)", () => {
  it("never locks, and stays indistinguishable from a wrong password", async () => {
    await resetRateLimitsForTests();
    const unknown = "no-such-person@example.test";
    const user = await createUser({ password: PASSWORD });

    const misses = [];
    for (let i = 0; i < MAX_FAILED_ATTEMPTS + 2; i++) {
      misses.push(await login(unknown, WRONG, `203.0.113.${100 + i}`));
    }
    // Still the ordinary failure, never ACCOUNT_LOCKED: locking an address
    // with no account would answer the question FR-1.6 refuses to answer.
    for (const res of misses) expect(res.status).toBe(401);

    const wrongPassword = await login(user.email, WRONG, "198.51.100.90");
    expect(wrongPassword.body.error.message).toBe(misses[0].body.error.message);
  }, 60_000);
});

describe("FR-1.2 — breached passwords are refused with a specific message", () => {
  it("rejects a common breached password at registration", async () => {
    await resetRateLimitsForTests();
    const res = await register("new-person@example.test", "password123");

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/data breaches/i);
    // Not `details`: SRS §4 fixes the error body at code, message and
    // requestId, so the message is the whole of what a client can act on.
    expect(Object.keys(res.body.error).sort()).toEqual(["code", "message", "requestId"]);
    expect(await prisma.user.count({ where: { email: "new-person@example.test" } })).toBe(0);
  }, 60_000);

  it("is case-insensitive — capitalising a common password does not rescue it", async () => {
    await resetRateLimitsForTests();
    expect((await register("a@example.test", "Password123")).status).toBe(400);
    await resetRateLimitsForTests();
    expect((await register("b@example.test", "PASSWORD123")).status).toBe(400);
  }, 60_000);

  it("says something more specific than 'invalid password'", async () => {
    // A generic rejection reads as a bug in the form; the person needs to
    // know it is this password, not the rule.
    await resetRateLimitsForTests();
    const res = await register("c@example.test", "qwerty123456");
    expect(res.body.error.message).not.toMatch(/^invalid/i);
    expect(res.body.error.message).toMatch(/choose a different one/i);
  }, 60_000);

  it("accepts an uncommon password of the same length", async () => {
    await resetRateLimitsForTests();
    const res = await register("d@example.test", "wheelbarrow-thistle-9");
    expect(res.status).toBe(201);
  }, 60_000);

  it("keeps the password on the server: the list is local, so nothing is sent anywhere", async () => {
    // FR-1.2 allows a k-anonymity range API; this build uses a bundled
    // list instead, so there is no outbound call to assert the absence of.
    // The check is a pure function over a file — provable by calling it.
    const { isBreachedPassword } = await import("../../src/services/breachedPasswords.js");
    expect(isBreachedPassword("password123")).toBe(true);
    expect(isBreachedPassword("wheelbarrow-thistle-9")).toBe(false);
  }, 30_000);
});
