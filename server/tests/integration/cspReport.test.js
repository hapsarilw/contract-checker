import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import config from "../../src/config.js";
import logger from "../../src/observability/logger.js";
import { cspViolationTotal } from "../../src/observability/metrics.js";

/**
 * FR-7.9's report endpoint (step 75), through the real app: the CSRF guard,
 * the limiter, the body parser and the error handler all in the path.
 */

const LEGACY = {
  "csp-report": {
    "document-uri": "https://app.example/reset-password?token=SECRET-RESET-TOKEN",
    "effective-directive": "script-src-elem",
    "blocked-uri": "https://cdn.tracker.example/t.js",
    "script-sample": "the contract says",
  },
};
const REPORTING_API = [
  {
    type: "csp-violation",
    body: {
      documentURL: "https://app.example/documents/abc",
      blockedURL: "inline",
      effectiveDirective: "style-src-attr",
    },
  },
];

/** @param {string} directive */
async function counted(directive) {
  const { values } = await cspViolationTotal.get();
  return values.find((v) => v.labels.directive === directive)?.value ?? 0;
}

/**
 * @param {unknown} body
 * @param {string} contentType
 */
const report = (body, contentType) =>
  request(testServer())
    .post("/api/csp-report")
    .set("Origin", config.FRONTEND_ORIGIN)
    .set("Content-Type", contentType)
    .send(typeof body === "string" ? body : JSON.stringify(body));

describe("POST /api/csp-report (FR-7.9, step 75)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts report-uri's format: 204, counted by directive, logged without the token or the sample", async () => {
    const warn = vi.spyOn(logger, "warn");
    const before = await counted("script-src-elem");

    const res = await report(LEGACY, "application/csp-report");

    expect(res.status).toBe(204);
    expect(await counted("script-src-elem")).toBe(before + 1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("script-src-elem");
    expect(logged).toContain("https://app.example/reset-password");
    expect(logged).not.toContain("SECRET-RESET-TOKEN");
    expect(logged).not.toContain("the contract says");
  });

  it("accepts the Reporting API's format", async () => {
    const before = await counted("style-src-attr");
    const res = await report(REPORTING_API, "application/reports+json");
    expect(res.status).toBe(204);
    expect(await counted("style-src-attr")).toBe(before + 1);
  });

  it("is not refused by the CSRF guard for its content type, with or without an Origin", async () => {
    const noOrigin = await request(testServer())
      .post("/api/csp-report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(LEGACY));
    expect(noOrigin.status).toBe(204);
  });

  it("the exemption is this route's alone: the same content type elsewhere is still refused", async () => {
    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .set("Origin", config.FRONTEND_ORIGIN)
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify({ email: "a@b.test", password: "x" }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_CHECK_FAILED");
  });

  it("a body in neither shape is 204 and counts nothing", async () => {
    const warn = vi.spyOn(logger, "warn");
    const res = await report({ hello: "world" }, "application/json");
    expect(res.status).toBe(204);
    expect(warn.mock.calls.filter((c) => String(c[1]).includes("FR-7.9"))).toHaveLength(
      0,
    );
  });

  it("a body over 16 KB is refused with the API's error shape, naming this route's limit", async () => {
    const big = {
      "csp-report": { "document-uri": `https://a.example/${"x".repeat(20_000)}` },
    };
    const res = await report(big, "application/csp-report");
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("FILE_TOO_LARGE");
    expect(res.body.error.message).toContain("policy report");
  });

  it("malformed JSON is a 400, not a 500", async () => {
    const res = await report("{not json", "application/csp-report");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("is rate limited: the 61st report from one address in 15 minutes is refused", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await report(LEGACY, "application/csp-report")).status).toBe(204);
    }
    const res = await report(LEGACY, "application/csp-report");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });
});
