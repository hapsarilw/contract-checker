import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { register } from "prom-client";
import config from "../../src/config.js";
import prisma from "../../src/lib/prisma.js";
import { getRedis } from "../../src/lib/redis.js";
import { SPEC_METRICS } from "../../src/observability/metrics.js";
import { REQUEST_ID_ATTRIBUTE } from "../../src/observability/tracing.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { countWords } from "../../src/services/extraction.js";
import { getLlmProvider } from "../../src/services/llm/index.js";
import { buildDocx } from "../helpers/buildDocx.js";
import { createDocument, createUser } from "./factories.js";
import { testServer } from "./testServer.js";
import { runCheck } from "../../../ops/synthetics/login-list.mjs";

/**
 * BUILD-PLAN step 67 against the real app, database and Redis: the
 * /metrics route, the metrics a real analysis moves, the traces it
 * leaves, and the synthetic check's way past the auth limiter.
 */

// Synthetic, as §11.3 requires of every fixture. The distinctive phrase is
// what the tracing test looks for in every span attribute: it must never
// appear.
const SECRET_PHRASE = "Zanzibar-Quillfeather indemnity clause";
const CONTRACT = [
  "DESIGN SERVICES AGREEMENT",
  "1. Revisions. The Client may request unlimited revisions at no additional cost.",
  "2. Payment. Invoices are payable within ninety (90) days of receipt.",
  `3. Liability. The ${SECRET_PHRASE} applies to all work without limit.`,
].join("\n\n");
const EXCERPT = "Invoices are payable within ninety (90) days of receipt.";

const mock = () =>
  /** @type {import("../../src/services/llm/mockProvider.js").MockLlmProvider} */ (
    getLlmProvider().backend
  );

async function signedInDocument() {
  const user = await createUser();
  const document = await createDocument({
    userId: user.id,
    rawText: CONTRACT,
    wordCount: countWords(CONTRACT),
  });
  const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });
  return { user, document, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

const analyze = (documentId, cookie) =>
  request(testServer())
    .post(`/api/v1/documents/${documentId}/analyze`)
    .set("Cookie", cookie)
    .set("Content-Type", "application/json");

/** A metric's current value for exactly these labels (0 if absent). */
async function valueOf(name, labels = {}) {
  const metric = /** @type {import("prom-client").Metric} */ (
    register.getSingleMetric(name)
  );
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want))
    .filter(
      (v) =>
        !("metricName" in v) || v.metricName === name || v.metricName === `${name}_count`,
    )
    .reduce((total, v) => total + v.value, 0);
}

describe("GET /metrics (§6.6, a token-protected route on the one port)", () => {
  it("refuses a request with no token, and one with the wrong token, without leaking anything", async () => {
    for (const auth of [
      undefined,
      "Bearer nope",
      `Bearer ${config.METRICS_TOKEN}x`,
      config.METRICS_TOKEN,
    ]) {
      const req = request(testServer()).get("/metrics");
      const res = await (auth
        ? req.set("Authorization", /** @type {string} */ (auth))
        : req);
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toMatch(/^Bearer/);
      expect(res.text).not.toContain("http_request_duration_seconds");
    }
  });

  it("serves the Prometheus exposition, naming every §6.6 metric, to the right token", async () => {
    const res = await request(testServer())
      .get("/metrics")
      .set("Authorization", `Bearer ${config.METRICS_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    for (const name of Object.keys(SPEC_METRICS)) {
      expect(res.text, name).toContain(`# TYPE ${name} `);
    }
    // Shared state read at scrape time: the configured ceiling, and the
    // breaker (closed in a fresh test database).
    expect(res.text).toContain(
      `llm_spend_ceiling_usd ${config.MONTHLY_SPEND_CEILING_USD}`,
    );
    expect(res.text).toMatch(/^llm_circuit_state 0$/m);
  });
});

describe("what a real analysis records (§6.6)", () => {
  it("a completed analysis moves the analysis, findings, token, provider and request metrics", async () => {
    const { document, cookie } = await signedInDocument();
    mock().scriptValidResponse({
      overall_risk: "medium",
      findings: [
        {
          category: "payment",
          severity: "high",
          clause_excerpt: EXCERPT,
          explanation: "Ninety days is a long time to wait for money you are owed.",
          suggested_change: "Ask for payment within fourteen days of the invoice.",
        },
      ],
    });
    const before = {
      completed: await valueOf("analysis_total", {
        outcome: "completed",
        error_code: "none",
      }),
      high: await valueOf("analysis_findings_total", { severity: "high" }),
      input: await valueOf("llm_tokens_total", {
        direction: "input",
        model: config.ANTHROPIC_MODEL,
      }),
      ok: await valueOf("llm_request_total", { outcome: "success", http_status: "200" }),
      drift: await valueOf("analysis_risk_drift_total", {
        rule_risk: "high",
        model_risk: "medium",
      }),
      requests: await valueOf("http_request_duration_seconds", {
        route: "/api/v1/documents/:id/analyze",
        method: "POST",
        status: "200",
      }),
    };

    const res = await analyze(document.id, cookie);

    expect(res.status).toBe(200);
    expect(
      await valueOf("analysis_total", { outcome: "completed", error_code: "none" }),
    ).toBe(before.completed + 1);
    expect(await valueOf("analysis_findings_total", { severity: "high" })).toBe(
      before.high + 1,
    );
    // The mock reports 500 input tokens per call.
    expect(
      await valueOf("llm_tokens_total", {
        direction: "input",
        model: config.ANTHROPIC_MODEL,
      }),
    ).toBe(before.input + 500);
    expect(
      await valueOf("llm_request_total", { outcome: "success", http_status: "200" }),
    ).toBe(before.ok + 1);
    // One high finding makes the rule say HIGH; the model said medium.
    expect(
      await valueOf("analysis_risk_drift_total", {
        rule_risk: "high",
        model_risk: "medium",
      }),
    ).toBe(before.drift + 1);
    // By route PATTERN, never the raw path with the document id in it.
    expect(
      await valueOf("http_request_duration_seconds", {
        route: "/api/v1/documents/:id/analyze",
        method: "POST",
        status: "200",
      }),
    ).toBe(before.requests + 1);
    const metric = /** @type {import("prom-client").Metric} */ (
      register.getSingleMetric("http_request_duration_seconds")
    );
    const routes = (await metric.get()).values.map((v) => v.labels.route);
    expect(routes.some((r) => typeof r === "string" && r.includes(document.id))).toBe(
      false,
    );
  });

  it("an analysis whose every finding is discarded counts as failed, and its discards still count", async () => {
    const { document, cookie } = await signedInDocument();
    mock().scriptValidResponse({
      findings: [
        {
          category: "scope",
          severity: "high",
          clause_excerpt: "This sentence is not anywhere in the contract at all.",
          explanation: "This can leave you doing unpaid work with no end date.",
          suggested_change: "Ask for two rounds of revisions, then an hourly rate.",
        },
      ],
    });
    const failed = await valueOf("analysis_total", {
      outcome: "failed",
      error_code: "ALL_FINDINGS_DISCARDED",
    });
    const discarded = await valueOf("analysis_findings_discarded_total");

    const res = await analyze(document.id, cookie);

    expect(res.status).toBe(502);
    expect(
      await valueOf("analysis_total", {
        outcome: "failed",
        error_code: "ALL_FINDINGS_DISCARDED",
      }),
    ).toBe(failed + 1);
    expect(await valueOf("analysis_findings_discarded_total")).toBe(discarded + 1);
  });
});

describe("traces (§6.6: extract, prompt, provider call, validate, verify, persist)", () => {
  const exporter = new InMemorySpanExporter();
  /** @type {NodeTracerProvider} */
  let provider;

  beforeAll(() => {
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });
  beforeEach(() => exporter.reset());

  it("an upload and an analysis leave every stage's span, each carrying its request's id and nothing of the document", async () => {
    const user = await createUser();
    const cookie = `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`;
    const docx = await buildDocx({
      paragraphs: CONTRACT.split("\n\n").concat(
        Array(30).fill(
          "The Designer shall deliver the agreed work on time and to the agreed standard.",
        ),
      ),
    });

    const upload = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .attach("file", docx, "contract.docx");
    expect(upload.status).toBe(201);

    mock().scriptValidResponse({
      findings: [
        {
          category: "payment",
          severity: "medium",
          clause_excerpt: EXCERPT,
          explanation: "Ninety days is a long time to wait for money you are owed.",
          suggested_change: "Ask for payment within fourteen days of the invoice.",
        },
      ],
    });
    const res = await analyze(upload.body.document.id, cookie);
    expect(res.status).toBe(200);

    const spans = exporter.getFinishedSpans();
    const byName = (name) => spans.filter((s) => s.name === name);

    // extract lives in the UPLOAD request's trace (tracing.js says why).
    const [extract] = byName("document.extract");
    expect(extract.attributes[REQUEST_ID_ATTRIBUTE]).toBe(upload.headers["x-request-id"]);

    const [root] = byName("analysis");
    expect(root.attributes[REQUEST_ID_ATTRIBUTE]).toBe(res.headers["x-request-id"]);
    for (const stage of [
      "analysis.prompt",
      "analysis.provider_call",
      "analysis.validate",
      "analysis.verify",
      "analysis.persist",
    ]) {
      const [span] = byName(stage);
      expect(span, stage).toBeDefined();
      expect(span.attributes[REQUEST_ID_ATTRIBUTE], stage).toBe(
        res.headers["x-request-id"],
      );
      // A child of the analysis span, in the same trace.
      expect(span.spanContext().traceId, stage).toBe(root.spanContext().traceId);
      expect(span.parentSpanContext?.spanId, stage).toBe(root.spanContext().spanId);
    }
    expect(byName("analysis.provider_call")[0].attributes["llm.attempts"]).toBe(1);

    // NFR-2.8 applies to traces: nothing of the document in any attribute.
    for (const span of spans) {
      for (const value of Object.values(span.attributes)) {
        expect(String(value)).not.toContain("Zanzibar");
        expect(String(value)).not.toContain("ninety (90) days");
      }
    }
  });

  it("a failed stage records the error CODE on its span, never the message", async () => {
    const { document, cookie } = await signedInDocument();
    mock().scriptMalformedJson().scriptMalformedJson();

    const res = await analyze(document.id, cookie);

    expect(res.status).toBe(502);
    const [root] = exporter.getFinishedSpans().filter((s) => s.name === "analysis");
    expect(root.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(root.status.message).toBe("LLM_INVALID_OUTPUT");
    expect(root.attributes["error.code"]).toBe("LLM_INVALID_OUTPUT");
    expect(root.events).toHaveLength(0);
  });
});

describe("the synthetic login check and NFR-2.6's auth limiter", () => {
  const TOKEN = /** @type {string} */ (config.SYNTHETIC_CHECK_TOKEN);
  const EMAIL = /** @type {string} */ (config.SYNTHETIC_ACCOUNT_EMAIL);
  const PASSWORD = "synthetic-password-123";
  let n = 0;
  /** A fresh documentation-range address per test, so tests don't share a limiter window. */
  const nextAllowlistedIp = () => `198.51.100.${10 + (n += 1)}`;

  beforeEach(async () => {
    await getRedis().flushdb();
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await createUser({ email: EMAIL, password: PASSWORD });
  });

  /**
   * @param {{ ip: string, token?: string, email?: string, path?: string }} options
   */
  const attempt = ({ ip, token = TOKEN, email = EMAIL, path = "/login" }) => {
    const req = request(testServer())
      .post(`/api/v1/auth${path}`)
      .set("Content-Type", "application/json")
      .set("X-Forwarded-For", ip);
    if (token) req.set("X-Synthetic-Check", token);
    return req.send({ email, password: PASSWORD });
  };

  it("a checker signing in every minute from two regions is never limited", async () => {
    const regions = [nextAllowlistedIp(), nextAllowlistedIp()];
    for (let minute = 0; minute < 8; minute += 1) {
      for (const ip of regions) {
        const res = await attempt({ ip });
        expect(res.status, `minute ${minute} from ${ip}`).toBe(200);
      }
    }
  });

  it.each([
    ["the wrong token", { token: "x".repeat(40) }],
    ["no token", { token: "" }],
    ["another account's email", { email: "someone-else@example.test" }],
    ["an address outside the allowlist", { ip: "203.0.113.50" }],
    ["/register instead of /login", { path: "/register" }],
  ])(
    "with %s, the request is counted like any other and the sixth is refused",
    async (_label, change) => {
      const override =
        /** @type {{ ip?: string, token?: string, email?: string, path?: string }} */ (
          change
        );
      const ip = override.ip ?? nextAllowlistedIp();
      const statuses = [];
      for (let i = 0; i < 6; i += 1)
        statuses.push((await attempt({ ...override, ip })).status);
      expect(statuses.slice(0, 5)).not.toContain(429);
      expect(statuses[5]).toBe(429);
    },
  );

  it("the login-and-list round trip consumes no analysis quota: nothing to exclude, by construction", async () => {
    const ip = nextAllowlistedIp();
    const login = await attempt({ ip });
    const cookie = login.headers["set-cookie"];
    const list = await request(testServer())
      .get("/api/v1/documents")
      .set("Cookie", cookie);
    expect(list.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.monthlyAnalyses).toBe(0);
    expect(await getRedis().keys("quota:*")).toEqual([]);
  });

  it("ops/synthetics/login-list.mjs itself passes against the real app, eight times running", async () => {
    const server = testServer();
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    for (let i = 0; i < 8; i += 1) {
      const result = await runCheck({
        baseUrl: `http://127.0.0.1:${port}`,
        email: EMAIL,
        password: PASSWORD,
        checkToken: TOKEN,
      });
      expect(result, JSON.stringify(result.steps)).toMatchObject({ ok: true });
      expect(result.steps.map((s) => s.step)).toEqual(["health", "login", "list"]);
    }
  });

  it("and it fails, saying why, when the limiter does count it", async () => {
    const server = testServer();
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    let result;
    for (let i = 0; i < 6; i += 1) {
      result = await runCheck({
        baseUrl: `http://127.0.0.1:${port}`,
        email: EMAIL,
        password: PASSWORD,
        checkToken: "wrong-".repeat(8),
      });
    }
    expect(result?.ok).toBe(false);
    expect(result?.steps.at(-1)).toMatchObject({
      step: "login",
      status: 429,
      reason: expect.stringMatching(/SYNTHETIC_CHECK_IPS/),
    });
  });
});
