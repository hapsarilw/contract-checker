import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import app from "../../src/app.js";
import config from "../../src/config.js";
import { createUser } from "./factories.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { registeredRoutes } from "../helpers/registeredRoutes.js";

const FOREIGN_ORIGIN = "https://evil.example.com";
const VALID_PASSWORD = "correct-horse-battery";

/**
 * TR-19 (SRS §10.3) — the CSRF and CORS stance from FR-1.12.
 *
 * Every case below is a state-changing request, because clause (c)
 * applies to those only; clause (d) — that GET routes are side-effect
 * free — is covered by the route audit at the bottom of this file.
 */
describe("TR-19 — CSRF and origin enforcement (FR-1.12)", () => {
  it("rejects a cross-origin credentialed request from a disallowed origin", async () => {
    const user = await createUser({ email: "csrf-cred@example.test" });
    const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });

    const res = await request(testServer())
      .post("/api/v1/auth/logout")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`)
      .set("Origin", FOREIGN_ORIGIN)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_CHECK_FAILED");
  });

  it("rejects a state-changing request bearing a foreign Origin header", async () => {
    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .set("Origin", FOREIGN_ORIGIN)
      .send({ email: "someone@example.test", password: VALID_PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_CHECK_FAILED");
  });

  it("rejects a state-changing request with Content-Type text/plain", async () => {
    // text/plain is one of the three encodings an HTML form can produce,
    // which is exactly why it is not on the allowlist.
    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .set("Content-Type", "text/plain")
      .send(JSON.stringify({ email: "someone@example.test", password: VALID_PASSWORD }));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_CHECK_FAILED");
  });

  it("allows a legitimate same-origin JSON request", async () => {
    await createUser({ email: "csrf-ok@example.test", password: VALID_PASSWORD });

    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .set("Origin", config.FRONTEND_ORIGIN)
      .send({ email: "csrf-ok@example.test", password: VALID_PASSWORD });

    expect(res.status).toBe(200);
  });
});

describe("clause (c) — the details that make it work", () => {
  it("rejects application/x-www-form-urlencoded, the other form encoding", async () => {
    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send("email=someone@example.test&password=whatever");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_CHECK_FAILED");
  });

  it("accepts application/json with a charset parameter", async () => {
    await createUser({ email: "charset@example.test", password: VALID_PASSWORD });

    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json; charset=utf-8")
      .send(JSON.stringify({ email: "charset@example.test", password: VALID_PASSWORD }));

    // A guard comparing the raw header would 403 every browser that
    // appends a charset.
    expect(res.status).toBe(200);
  });

  it("allows an ABSENT Origin — non-browser clients omit it, and the attack it guards is a browser being made to send a request", async () => {
    await createUser({ email: "noorigin@example.test", password: VALID_PASSWORD });

    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .send({ email: "noorigin@example.test", password: VALID_PASSWORD });

    expect(res.status).toBe(200);
  });

  it("rejects a foreign Origin before the body is even parsed", async () => {
    // Malformed JSON that would fail the body parser — the 403 proves
    // the guard ran first and no parsing work was spent on a hostile
    // request.
    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .set("Origin", FOREIGN_ORIGIN)
      .set("Content-Type", "application/json")
      .send("{ this is not valid json");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_CHECK_FAILED");
  });

  it("requires Content-Type even on a BODYLESS state-changing request", async () => {
    const user = await createUser({ email: "bodyless@example.test" });
    const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });

    // FR-1.12(c) says "every state-changing endpoint", with no exception
    // for requests that have nothing to encode. The consequence is a real
    // constraint on every client: `fetch(url, { method: "POST" })` with
    // no body sends no Content-Type and gets a 403 here. The API client
    // built at step 31 must set the header on ALL state-changing
    // requests, logout included, or logout breaks in production with a
    // confusing CSRF rejection.
    //
    // This test exists to make that constraint deliberate and visible
    // rather than something the next person discovers from a bug report.
    const withoutHeader = await request(testServer())
      .post("/api/v1/auth/logout")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`);

    expect(withoutHeader.status).toBe(403);
    expect(withoutHeader.body.error.code).toBe("CSRF_CHECK_FAILED");

    const withHeader = await request(testServer())
      .post("/api/v1/auth/logout")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${token}`)
      .set("Content-Type", "application/json");

    expect(withHeader.status).toBe(200);
  });

  it("does not apply to safe methods — GET with a foreign Origin still works", async () => {
    const res = await request(testServer())
      .get("/api/health")
      .set("Origin", FOREIGN_ORIGIN);
    expect(res.status).toBe(200);
  });

  it("guards DELETE and PATCH too, not only POST", async () => {
    for (const method of ["delete", "patch", "put"]) {
      const agent = request(testServer());
      const res = await agent[method]("/api/v1/auth/logout")
        .set("Origin", FOREIGN_ORIGIN)
        .set("Content-Type", "application/json");

      // 403 from the guard, not 404 from the router — the guard runs
      // before routing, so an unrouted method is still rejected on
      // origin grounds first.
      expect(res.status, `${method} was not guarded`).toBe(403);
      expect(res.body.error.code).toBe("CSRF_CHECK_FAILED");
    }
  });
});

/**
 * Clause (d) — "GET endpoints are side-effect free ... audit the routes
 * as they are added."
 *
 * Nothing can mechanically prove a handler has no side effects, so this
 * makes the audit a deliberate act instead: every GET and HEAD route the
 * app registers must appear below, and adding one to the app without
 * adding it here fails the suite. The list is the record of what a human
 * checked.
 */
const AUDITED_SIDE_EFFECT_FREE_GET_ROUTES = [
  "GET /api/health", // returns a constant
  "GET /api/ready", // SELECT 1 against Postgres; reads only
  "GET /api/version", // reads config
  "GET /api/v1/auth/me", // findUnique on the session's own user
  "GET /api/v1/documents/:id", // findFirst on the document and its latest analysis; reads only
  "GET /api/v1/documents/", // findMany, cursor-paginated; reads only (registeredRoutes concatenates the mount prefix with the route's own "/" path)
  "GET /api/v1/account/export", // FR-4.5: findUniqueOrThrow + findMany over the caller's own rows; writes nothing, not even an audit event
  // §6.6 (step 67): renders the registry. Its scrape-time collectors only
  // read: Redis HGETALL/GET/LRANGE (spend, circuit breaker), JobRun
  // findMany/findUnique, pool counters, and an Analysis aggregate when
  // Redis has no spend figure yet this month (a read, but a real query per
  // scrape; cheap at Phase 1.5 scale).
  "GET /metrics",
];

describe("clause (d) — GET routes are audited as side-effect free", () => {
  it("has no GET or HEAD route that has not been audited", () => {
    const readRoutes = registeredRoutes(app).filter((route) =>
      /^(GET|HEAD) /.test(route),
    );
    const unaudited = readRoutes.filter(
      (route) => !AUDITED_SIDE_EFFECT_FREE_GET_ROUTES.includes(route),
    );

    expect(
      unaudited,
      "a new GET route was added without auditing it for side effects (FR-1.12(d)) — " +
        "confirm it only reads, then add it to AUDITED_SIDE_EFFECT_FREE_GET_ROUTES",
    ).toEqual([]);
  });

  it("does not list routes that no longer exist", () => {
    const readRoutes = registeredRoutes(app).filter((route) =>
      /^(GET|HEAD) /.test(route),
    );
    const stale = AUDITED_SIDE_EFFECT_FREE_GET_ROUTES.filter(
      (route) => !readRoutes.includes(route),
    );

    expect(stale, "the audit list has drifted from the app's actual routes").toEqual([]);
  });
});
