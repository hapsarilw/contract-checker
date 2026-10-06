import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../../src/lib/prisma.js";
import config from "../../src/config.js";
import { createUser } from "./factories.js";
import { SESSION_COOKIE_NAME } from "../../src/services/auth.js";

const VALID_PASSWORD = "correct-horse-battery";

/** Pulls the session cookie's raw Set-Cookie string off a response. */
function sessionCookieHeader(res) {
  const header = res.headers["set-cookie"] ?? [];
  return header.find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
}

/** The cookie in "name=value" form, for sending back on a later request. */
function sessionCookieValue(res) {
  const raw = sessionCookieHeader(res);
  return raw?.split(";")[0];
}

describe("POST /api/v1/auth/register (FR-1.1, FR-1.2, FR-1.6)", () => {
  it("creates an UNVERIFIED user whose password is a bcrypt hash, never the plaintext", async () => {
    const res = await request(testServer())
      .post("/api/v1/auth/register")
      .send({ email: "new@example.test", password: VALID_PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.user.state).toBe("UNVERIFIED");

    const stored = await prisma.user.findUnique({ where: { email: "new@example.test" } });
    if (!stored) throw new Error("registration did not persist a user row");
    expect(stored.passwordHash).not.toBe(VALID_PASSWORD);
    expect(stored.passwordHash.startsWith("$2b$12$")).toBe(true);
    expect(await bcrypt.compare(VALID_PASSWORD, stored.passwordHash)).toBe(true);
  });

  it("never returns the password hash or tokenVersion to the client", async () => {
    const res = await request(testServer())
      .post("/api/v1/auth/register")
      .send({ email: "shape@example.test", password: VALID_PASSWORD });

    expect(Object.keys(res.body.user).sort()).toEqual([
      "createdAt",
      "email",
      "emailVerifiedAt",
      "id",
      "pendingEmail",
      "state",
    ]);
    expect(JSON.stringify(res.body)).not.toContain(VALID_PASSWORD);
  });

  it("trims and lowercases the email before storing it (FR-1.1)", async () => {
    const res = await request(testServer())
      .post("/api/v1/auth/register")
      .send({ email: "  MiXeD@Example.COM  ", password: VALID_PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("mixed@example.com");
    expect(
      await prisma.user.findUnique({ where: { email: "mixed@example.com" } }),
    ).not.toBeNull();
  });

  it("returns 409 EMAIL_TAKEN for a duplicate email", async () => {
    await createUser({ email: "taken@example.test" });

    const res = await request(testServer())
      .post("/api/v1/auth/register")
      .send({ email: "taken@example.test", password: VALID_PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("treats a differently-cased duplicate as taken — normalisation happens before the uniqueness check", async () => {
    await createUser({ email: "case@example.test" });

    const res = await request(testServer())
      .post("/api/v1/auth/register")
      .send({ email: "CASE@Example.test", password: VALID_PASSWORD });

    expect(res.status).toBe(409);
  });

  it.each([
    ["9 characters", "123456789"],
    ["201 characters", "a".repeat(201)],
  ])("rejects a password of %s with 400 VALIDATION_ERROR", async (_label, password) => {
    const res = await request(testServer())
      .post("/api/v1/auth/register")
      .send({ email: `len-${_label.replace(/\W/g, "")}@example.test`, password });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it.each([
    // Not "1234567890": that is on FR-1.2's breached list (step 54), so it
    // would be refused for a reason that has nothing to do with the length
    // bound this case exists to check.
    ["10 characters", "qz7-plum-w"],
    ["200 characters", "a".repeat(200)],
  ])(
    "accepts a password of exactly %s — the bounds are inclusive",
    async (_label, password) => {
      const res = await request(testServer())
        .post("/api/v1/auth/register")
        .send({ email: `ok-${_label.replace(/\W/g, "")}@example.test`, password });

      expect(res.status).toBe(201);
    },
  );

  it("never echoes the submitted password back in a validation error", async () => {
    const password = "short";
    const res = await request(testServer())
      .post("/api/v1/auth/register")
      .send({ email: "leak@example.test", password });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(password);
  });

  it("rejects a malformed email", async () => {
    const res = await request(testServer())
      .post("/api/v1/auth/register")
      .send({ email: "not-an-email", password: VALID_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/v1/auth/login (FR-1.3, FR-1.6)", () => {
  it("sets the session cookie with all four required attributes (FR-1.3)", async () => {
    await createUser({ email: "cookie@example.test", password: VALID_PASSWORD });

    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "cookie@example.test", password: VALID_PASSWORD });

    expect(res.status).toBe(200);
    const cookie = sessionCookieHeader(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
  });

  it("omits Secure outside production, so the cookie works over plain HTTP locally", async () => {
    // config.isProduction is false under NODE_ENV=test (tests/setup.js).
    expect(config.isProduction).toBe(false);
    await createUser({ email: "insecure@example.test", password: VALID_PASSWORD });

    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "insecure@example.test", password: VALID_PASSWORD });

    expect(sessionCookieHeader(res)).not.toContain("Secure");
  });

  it("issues a JWT that decodes to { sub, tv } and expires in 7 days", async () => {
    const user = await createUser({
      email: "jwt@example.test",
      password: VALID_PASSWORD,
    });

    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "jwt@example.test", password: VALID_PASSWORD });

    const token = sessionCookieValue(res).split("=")[1];
    const claims = jwt.verify(decodeURIComponent(token), config.JWT_SECRET, {
      algorithms: ["HS256"],
    });

    expect(claims.sub).toBe(user.id);
    expect(claims.tv).toBe(user.tokenVersion);
    expect(claims.exp - claims.iat).toBe(7 * 24 * 60 * 60);
  });

  it("signs with HS256, not none — an unsigned forgery must not verify", async () => {
    const user = await createUser({
      email: "alg@example.test",
      password: VALID_PASSWORD,
    });
    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "alg@example.test", password: VALID_PASSWORD });

    const token = decodeURIComponent(sessionCookieValue(res).split("=")[1]);
    expect(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).alg).toBe(
      "HS256",
    );

    // The classic algorithm-confusion attack: same claims, alg "none",
    // no signature. It must not be accepted by /me.
    const forged = jwt.sign({ sub: user.id, tv: user.tokenVersion }, "", {
      algorithm: "none",
    });
    const meRes = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${forged}`);

    expect(meRes.status).toBe(401);
  });

  describe("FR-1.6 — unknown email and wrong password are indistinguishable", () => {
    it("returns identical response bodies apart from the per-request requestId", async () => {
      await createUser({ email: "known@example.test", password: VALID_PASSWORD });

      const unknownEmail = await request(testServer())
        .post("/api/v1/auth/login")
        .send({ email: "nobody@example.test", password: VALID_PASSWORD });

      const wrongPassword = await request(testServer())
        .post("/api/v1/auth/login")
        .send({ email: "known@example.test", password: "definitely-not-it" });

      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.status).toBe(401);

      // requestId is deliberately unique per request (§4) — it is the one
      // field that MUST differ. Everything else has to match exactly.
      const strip = (body) => ({ ...body.error, requestId: undefined });
      expect(strip(unknownEmail.body)).toEqual(strip(wrongPassword.body));
      expect(unknownEmail.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("sets no session cookie on either failure", async () => {
      await createUser({ email: "nocookie@example.test", password: VALID_PASSWORD });

      const unknownEmail = await request(testServer())
        .post("/api/v1/auth/login")
        .send({ email: "ghost@example.test", password: VALID_PASSWORD });
      const wrongPassword = await request(testServer())
        .post("/api/v1/auth/login")
        .send({ email: "nocookie@example.test", password: "wrong-password-here" });

      expect(sessionCookieHeader(unknownEmail)).toBeUndefined();
      expect(sessionCookieHeader(wrongPassword)).toBeUndefined();
    });

    it("spends comparable time on both paths, so timing is not an existence oracle", async () => {
      // Registers through the API rather than the factory, deliberately.
      // createUser hashes at cost 4 to keep the suite fast; this test
      // needs the production cost of 12, because the whole question is
      // whether the unknown-email path burns the SAME bcrypt work as a
      // real comparison. Against a cost-4 fixture the ratio is ~50x and
      // says nothing about production.
      await request(testServer())
        .post("/api/v1/auth/register")
        .send({ email: "timing@example.test", password: VALID_PASSWORD });

      const time = async (body) => {
        const startedAt = process.hrtime.bigint();
        await request(testServer()).post("/api/v1/auth/login").send(body);
        return Number(process.hrtime.bigint() - startedAt) / 1e6;
      };

      const unknownMs = await time({
        email: "absent@example.test",
        password: VALID_PASSWORD,
      });
      const wrongMs = await time({
        email: "timing@example.test",
        password: "wrong-password-here",
      });

      // The point is the ORDER OF MAGNITUDE, not a tight bound: without
      // the dummy compare the unknown-email path costs ~1ms against
      // ~250ms of bcrypt work, a 100x+ gap trivially measurable over a
      // network. A generous ratio still catches that regression while
      // staying stable on a loaded CI machine.
      const ratio = Math.max(unknownMs, wrongMs) / Math.min(unknownMs, wrongMs);
      expect(ratio).toBeLessThan(3);
    });
  });

  it("rejects a login whose password is empty with 401, not 400 — every credential guess funnels to one answer", async () => {
    await createUser({ email: "empty@example.test", password: VALID_PASSWORD });

    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "empty@example.test", password: "" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("does not length-validate the login password — a short guess is 401, never 400", async () => {
    await createUser({ email: "shortguess@example.test", password: VALID_PASSWORD });

    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "shortguess@example.test", password: "short" });

    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("clears the session cookie", async () => {
    await createUser({ email: "logout@example.test", password: VALID_PASSWORD });
    const login = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "logout@example.test", password: VALID_PASSWORD });

    const res = await request(testServer())
      .post("/api/v1/auth/logout")
      .set("Cookie", sessionCookieValue(login))
      // Required even though there is no body: FR-1.12(c) applies to
      // every state-changing request. See csrf.js.
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    const cleared = sessionCookieHeader(res);
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=;`);
    // Clearing must repeat the original attributes or the browser keeps
    // the cookie it already has.
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("HttpOnly");
  });

  it("requires a session (FR-1.4)", async () => {
    const res = await request(testServer())
      .post("/api/v1/auth/logout")
      .set("Content-Type", "application/json");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("GET /api/v1/auth/me", () => {
  it("returns the current user including account state", async () => {
    const user = await createUser({
      email: "me@example.test",
      password: VALID_PASSWORD,
      state: "UNVERIFIED",
    });
    const login = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "me@example.test", password: VALID_PASSWORD });

    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", sessionCookieValue(login));

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.state).toBe("UNVERIFIED");
    expect(res.body.user).not.toHaveProperty("passwordHash");
  });

  it("does NOT block an UNVERIFIED account — verification gates analysis, not the door (FR-1.7)", async () => {
    await createUser({
      email: "unverified@example.test",
      password: VALID_PASSWORD,
      state: "UNVERIFIED",
    });

    const login = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "unverified@example.test", password: VALID_PASSWORD });
    expect(login.status).toBe(200);

    const me = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", sessionCookieValue(login));
    expect(me.status).toBe(200);
  });

  it("returns 401 without a cookie", async () => {
    const res = await request(testServer()).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("returns 401 for a token signed with the wrong secret", async () => {
    const user = await createUser({ email: "wrongsecret@example.test" });
    const forged = jwt.sign(
      { sub: user.id, tv: user.tokenVersion },
      "a-different-secret-entirely",
      {
        algorithm: "HS256",
      },
    );

    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${forged}`);

    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired token", async () => {
    const user = await createUser({ email: "expired@example.test" });
    const expired = jwt.sign({ sub: user.id, tv: user.tokenVersion }, config.JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: -60,
    });

    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${expired}`);

    expect(res.status).toBe(401);
  });

  it("returns 401 when the token's subject no longer exists", async () => {
    const user = await createUser({
      email: "deleted@example.test",
      password: VALID_PASSWORD,
    });
    const login = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "deleted@example.test", password: VALID_PASSWORD });

    await prisma.user.delete({ where: { id: user.id } });

    const res = await request(testServer())
      .get("/api/v1/auth/me")
      .set("Cookie", sessionCookieValue(login));
    expect(res.status).toBe(401);
  });
});
