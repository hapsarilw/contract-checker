import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { createUser } from "./factories.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";

/**
 * The middleware is exercised through GET /api/v1/auth/me, the only
 * authenticated route that exists yet. Document routes arrive at step 18
 * and analyze at step 25; the same middleware guards them, so what holds
 * here holds there.
 */
const cookieFor = (token) => [`${SESSION_COOKIE_NAME}=${token}`];

const tokenFor = (user, overrides = {}) =>
  signSessionToken({
    userId: overrides.userId ?? user.id,
    tokenVersion: overrides.tokenVersion ?? user.tokenVersion,
  });

describe("requireAuth (FR-1.4)", () => {
  it("rejects a request with no cookie", async () => {
    const res = await request(testServer()).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a garbage token", async () => {
    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookieFor("not-a-jwt"));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("accepts a valid session and attaches the user", async () => {
    const user = await createUser({ email: "valid@example.test" });
    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookieFor(tokenFor(user)));

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });

  it("never lets the password hash reach the response", async () => {
    const user = await createUser({ email: "nohash@example.test" });
    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookieFor(tokenFor(user)));

    expect(JSON.stringify(res.body)).not.toContain("$2b$");
    expect(res.body.user).not.toHaveProperty("passwordHash");
  });
});

describe("token revocation via tokenVersion (FR-1.9, PRD D5)", () => {
  it("rejects a token whose tv is stale with 401 SESSION_REVOKED", async () => {
    const user = await createUser({ email: "revoked@example.test" });
    const token = tokenFor(user); // tv = 0

    // Exactly what a password reset, password change, sign-out-everywhere
    // or account deletion does (steps 53-57): bump one integer.
    await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: 1 } });

    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookieFor(token));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });

  it("distinguishes a revoked session from an unauthenticated one — the user is told to sign in again, not that nothing happened", async () => {
    const user = await createUser({ email: "distinct@example.test" });
    const token = tokenFor(user);
    await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: 5 } });

    const revoked = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookieFor(token));
    const missing = await request(testServer()).get("/api/v1/auth/me");

    expect(revoked.body.error.code).toBe("SESSION_REVOKED");
    expect(missing.body.error.code).toBe("UNAUTHENTICATED");
    expect(revoked.body.error.message).not.toBe(missing.body.error.message);
  });

  it("accepts a freshly issued token after the bump — revocation kills old sessions, not the account", async () => {
    const user = await createUser({ email: "rotated@example.test" });
    await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: 1 } });

    const reissued = signSessionToken({ userId: user.id, tokenVersion: 1 });
    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookieFor(reissued));

    expect(res.status).toBe(200);
  });

  it("rejects a token carrying a tv the user has never had", async () => {
    const user = await createUser({ email: "forgedtv@example.test" });
    const forged = tokenFor(user, { tokenVersion: 999 });

    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookieFor(forged));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });
});

describe("account state enforcement", () => {
  it("rejects a SUSPENDED account with 403 ACCOUNT_SUSPENDED", async () => {
    const user = await createUser({
      email: "suspended@example.test",
      state: "SUSPENDED",
    });
    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookieFor(tokenFor(user)));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED");
  });

  it("does NOT block an UNVERIFIED account — FR-1.7 gates analysis, not the door", async () => {
    const user = await createUser({
      email: "unverified2@example.test",
      state: "UNVERIFIED",
    });
    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookieFor(tokenFor(user)));

    expect(res.status).toBe(200);
    expect(res.body.user.state).toBe("UNVERIFIED");
  });

  it("does NOT block a LOCKED account — FR-1.10's lockout stops password guessing at login, and an existing session was not obtained by guessing", async () => {
    const user = await createUser({ email: "locked@example.test", state: "LOCKED" });
    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookieFor(tokenFor(user)));

    expect(res.status).toBe(200);
  });

  it("rejects a token whose subject was deleted", async () => {
    const user = await createUser({ email: "gone@example.test" });
    const token = tokenFor(user);
    await prisma.user.delete({ where: { id: user.id } });

    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", cookieFor(token));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("no email-verification check exists in the middleware", () => {
  it("has no reference to verification state in its source", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../../src/middleware/auth.js", import.meta.url)),
      "utf8",
    );

    // Strip comments — the file discusses verification at length to
    // explain why it is absent, and that prose must not be mistaken for
    // an implementation.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toContain("emailVerifiedAt");
    expect(code).not.toContain("EMAIL_NOT_VERIFIED");
    expect(code).not.toContain("UNVERIFIED");
  });
});
