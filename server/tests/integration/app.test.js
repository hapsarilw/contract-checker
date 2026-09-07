import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../src/app.js";
import config from "../../src/config.js";

describe("app.js — Express wiring (SRS §2 diagram)", () => {
  it("sets trust proxy, required behind the platform proxy (§2)", () => {
    expect(app.get("trust proxy")).toBe(1);
  });

  it("returns the standard error shape for an unknown route", async () => {
    const res = await request(app).get("/this/route/does/not/exist");

    expect(res.status).toBe(404);
    expect(Object.keys(res.body)).toEqual(["error"]);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.message).toBeTypeOf("string");
    expect(res.body.error.requestId).toBeTypeOf("string");
  });

  it("returns a matching X-Request-Id header and body requestId on every response", async () => {
    const res = await request(app).get("/unknown");
    expect(res.headers["x-request-id"]).toBeTypeOf("string");
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });

  it("echoes back an inbound X-Request-Id instead of generating a new one", async () => {
    const res = await request(app).get("/unknown").set("X-Request-Id", "client-supplied-abc");
    expect(res.headers["x-request-id"]).toBe("client-supplied-abc");
    expect(res.body.error.requestId).toBe("client-supplied-abc");
  });

  describe("security headers (NFR-2.2, NFR-2.3, FR-7.9)", () => {
    it("sets a Content-Security-Policy matching FR-7.9's directives", async () => {
      const res = await request(app).get("/unknown");
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
      const res = await request(app).get("/unknown");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("does NOT set HSTS outside production (NFR-2.2)", async () => {
      // tests/setup.js seeds NODE_ENV=test, so config.isProduction is false.
      expect(config.isProduction).toBe(false);
      const res = await request(app).get("/unknown");
      expect(res.headers["strict-transport-security"]).toBeUndefined();
    });
  });

  describe("CORS (NFR-2.4, FR-1.12(b))", () => {
    it("allows exactly config.FRONTEND_ORIGIN, with credentials", async () => {
      const res = await request(app).get("/unknown").set("Origin", config.FRONTEND_ORIGIN);

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
      const res = await request(app).get("/unknown").set("Origin", "https://evil.example.com");

      expect(res.headers["access-control-allow-origin"]).toBe(config.FRONTEND_ORIGIN);
      expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example.com");
    });

    it("never reflects an arbitrary Origin back", async () => {
      const attackerOrigin = "https://attacker.test";
      const res = await request(app).get("/unknown").set("Origin", attackerOrigin);

      expect(res.headers["access-control-allow-origin"]).not.toBe(attackerOrigin);
    });
  });
});
