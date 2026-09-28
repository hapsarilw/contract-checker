import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import app from "../../src/app.js";
import config from "../../src/config.js";

describe("app.js — Express wiring (SRS §2 diagram)", () => {
  it("sets trust proxy, required behind the platform proxy (§2)", () => {
    expect(app.get("trust proxy")).toBe(1);
  });

  it("returns the standard error shape for an unknown route", async () => {
    const res = await request(testServer()).get("/this/route/does/not/exist");

    expect(res.status).toBe(404);
    expect(Object.keys(res.body)).toEqual(["error"]);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.message).toBeTypeOf("string");
    expect(res.body.error.requestId).toBeTypeOf("string");
  });

  it("returns a matching X-Request-Id header and body requestId on every response", async () => {
    const res = await request(testServer()).get("/unknown");
    expect(res.headers["x-request-id"]).toBeTypeOf("string");
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });

  it("echoes back an inbound X-Request-Id instead of generating a new one", async () => {
    const res = await request(testServer())
      .get("/unknown")
      .set("X-Request-Id", "client-supplied-abc");
    expect(res.headers["x-request-id"]).toBe("client-supplied-abc");
    expect(res.body.error.requestId).toBe("client-supplied-abc");
  });

  describe("security headers (NFR-2.2, NFR-2.3, FR-7.9)", () => {
    it("sets a Content-Security-Policy matching FR-7.9's directives", async () => {
      const res = await request(testServer()).get("/unknown");
      const csp = res.headers["content-security-policy"];

      expect(csp).toBeTypeOf("string");
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
    });

    it("sets other standard helmet security headers", async () => {
      const res = await request(testServer()).get("/unknown");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("does NOT set HSTS outside production (NFR-2.2)", async () => {
      // tests/setup.js seeds NODE_ENV=test, so config.isProduction is false.
      expect(config.isProduction).toBe(false);
      const res = await request(testServer()).get("/unknown");
      expect(res.headers["strict-transport-security"]).toBeUndefined();
    });
  });

  describe("CORS (NFR-2.4, FR-1.12(b))", () => {
    it("allows exactly config.FRONTEND_ORIGIN, with credentials", async () => {
      const res = await request(testServer())
        .get("/unknown")
        .set("Origin", config.FRONTEND_ORIGIN);

      expect(res.headers["access-control-allow-origin"]).toBe(config.FRONTEND_ORIGIN);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("rejects a disallowed origin — the header never names the requester's origin", async () => {
      // `cors` with a static-string `origin` always emits that exact
      // value, for every request — it never omits the header and never
      // echoes the incoming Origin. That's what makes this safe: a page
      // at evil.example.com receives an Access-Control-Allow-Origin that
      // does NOT match its own origin, so the browser still refuses to
      // let its script read the response, even though the header is
      // technically present on the wire.
      const res = await request(testServer())
        .get("/unknown")
        .set("Origin", "https://evil.example.com");

      expect(res.headers["access-control-allow-origin"]).toBe(config.FRONTEND_ORIGIN);
      expect(res.headers["access-control-allow-origin"]).not.toBe(
        "https://evil.example.com",
      );
    });

    it("exposes Retry-After to the frontend, so degraded mode knows how long an outage is (FR-7.10)", async () => {
      const res = await request(testServer())
        .get("/unknown")
        .set("Origin", config.FRONTEND_ORIGIN);

      expect(res.headers["access-control-expose-headers"]).toBe("Retry-After");
    });

    it("never reflects an arbitrary Origin back", async () => {
      const attackerOrigin = "https://attacker.test";
      const res = await request(testServer())
        .get("/unknown")
        .set("Origin", attackerOrigin);

      expect(res.headers["access-control-allow-origin"]).not.toBe(attackerOrigin);
    });
  });

  describe("malformed JSON bodies never reach the global handler as 500", () => {
    // Exercised via /auth/login specifically because it's public — no
    // session needed — and parses a JSON body, which is all this needs.
    // The fix lives in app.js, immediately after express.json(), so it
    // protects every JSON route, not just this one; step 18's own tests
    // cover the same fix through /documents.

    it("an unparseable JSON body returns 400 VALIDATION_ERROR, not 500", async () => {
      const res = await request(testServer())
        .post("/api/v1/auth/login")
        .set("Content-Type", "application/json")
        .send("{ this is not valid json");

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("an oversized JSON body returns 413 FILE_TOO_LARGE, not 500, with a message about the 1 MB paste limit", async () => {
      const res = await request(testServer())
        .post("/api/v1/auth/login")
        .send({ email: "x@example.test", password: "x".repeat(2 * 1024 * 1024) });

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe("FILE_TOO_LARGE");
      expect(res.body.error.message).toContain("1 MB");
    });

    it("does not misclassify a real AppError as a body-parser error", async () => {
      // AppError never carries a `.type` property — this proves the
      // detector in app.js can't accidentally intercept an application
      // error and relabel it.
      const res = await request(testServer())
        .post("/api/v1/auth/login")
        .send({ email: "nobody@example.test", password: "wrong-password" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    });
  });
});
