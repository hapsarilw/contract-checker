import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import { once } from "node:events";
import app from "../../src/app.js";
import config from "../../src/config.js";
import prisma from "../../src/lib/prisma.js";
import { PROMPT_VERSION } from "../../src/prompts/analyze.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { countWords } from "../../src/services/extraction.js";
import { getLlmProvider } from "../../src/services/llm/index.js";
import { MockLlmProvider } from "../../src/services/llm/mockProvider.js";
import { createAnalysis, createDocument, createUser } from "./factories.js";

/**
 * SRS §2.2 — POST /api/v1/documents/:id/analyze end to end, against the
 * ephemeral Postgres and the scripted mock provider (TR-4, TR-5, TR-7,
 * TR-8, TR-20).
 */

// Synthetic, as §11.3 requires of every fixture.
const CONTRACT = [
  "DESIGN SERVICES AGREEMENT",
  "1. Revisions. The Client may request unlimited revisions at no additional cost.",
  "2. Payment. Invoices are payable within ninety (90) days of receipt.",
  "3. Ownership. All work product becomes the property of the Client upon creation, whether or not payment has been made.",
  "4. Termination. The Client may terminate this Agreement at any time without payment for work in progress.",
].join("\n\n");

const EXCERPTS = {
  revisions: "The Client may request unlimited revisions at no additional cost.",
  payment: "Invoices are payable within ninety (90) days of receipt.",
  ownership: "All work product becomes the property of the Client upon creation",
};

const FABRICATED = [
  "The Designer must pay a penalty of $500 for each late day.",
  "Either party may assign this Agreement without consent.",
];

/** A §5.2 finding as the model returns it. */
function finding(severity, clauseExcerpt, category = "scope") {
  return {
    category,
    severity,
    clause_excerpt: clauseExcerpt,
    explanation: "This can leave you doing unpaid work with no end date.",
    suggested_change: "Ask for two rounds of revisions, then an hourly rate.",
  };
}

function mockProvider() {
  const backend = getLlmProvider().backend;
  if (!(backend instanceof MockLlmProvider)) {
    throw new Error("integration tests run with LLM_PROVIDER=mock");
  }
  return backend;
}

async function ownedDocument() {
  const user = await createUser();
  const document = await createDocument({
    userId: user.id,
    rawText: CONTRACT,
    wordCount: countWords(CONTRACT),
  });
  const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });
  return { user, document, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

/**
 * Bodyless, but FR-1.12(c) still requires a JSON Content-Type on a POST.
 *
 * `target` is always a LISTENING SERVER, never the Express app. Handing
 * supertest the app makes it bind and close a fresh http.Server per
 * request, which is the flake testServer.js documents. Nearly every call
 * passes the shared one; the FR-3.8 concurrency test below passes a server
 * of its own, on purpose, because it needs two simultaneous requests to be
 * visibly arriving at one process.
 */
function analyze(target, documentId, cookie) {
  return request(target)
    .post(`/api/v1/documents/${documentId}/analyze`)
    .set("Cookie", cookie)
    .set("Content-Type", "application/json");
}

function analysesOf(documentId) {
  return prisma.analysis.findMany({ where: { documentId }, include: { findings: true } });
}

async function waitFor(read, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the row");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a successful analysis (§2.2 steps 4-12)", () => {
  it("returns the full report: verified findings sorted high to low, risk from the rule", async () => {
    const { document, cookie } = await ownedDocument();
    mockProvider().scriptValidResponse({
      overall_risk: "low",
      findings: [
        finding("low", EXCERPTS.payment, "payment"),
        finding("high", EXCERPTS.ownership, "ip"),
        finding("medium", EXCERPTS.revisions),
      ],
      missing_clauses: ["No late payment interest is specified."],
    });

    const res = await analyze(testServer(), document.id, cookie);

    expect(res.status).toBe(200);
    const { analysis } = res.body;
    expect(Object.keys(analysis).sort()).toEqual([
      "createdAt",
      "discardedFindings",
      "findings",
      "id",
      "missingClauses",
      "overallRisk",
      "status",
      "summary",
    ]);
    expect(analysis.status).toBe("COMPLETED");
    expect(analysis.overallRisk).toBe("HIGH");
    expect(analysis.findings.map((item) => item.severity)).toEqual([
      "HIGH",
      "MEDIUM",
      "LOW",
    ]);
    expect(analysis.findings.map((item) => item.category)).toEqual([
      "IP",
      "SCOPE",
      "PAYMENT",
    ]);
    expect(analysis.findings[0].clauseExcerpt).toBe(EXCERPTS.ownership);
    expect(analysis.missingClauses).toEqual(["No late payment interest is specified."]);
    expect(analysis.discardedFindings).toBe(0);
  });

  it("stores the model's own risk claim and the instrumentation, and returns neither", async () => {
    const { document, cookie } = await ownedDocument();
    mockProvider().scriptValidResponse({
      overall_risk: "low",
      findings: [finding("high", EXCERPTS.ownership, "ip")],
    });

    const res = await analyze(testServer(), document.id, cookie);

    expect(res.status).toBe(200);
    expect(res.body.analysis).not.toHaveProperty("modelRisk");
    const [row] = await analysesOf(document.id);
    expect(row).toMatchObject({
      status: "COMPLETED",
      overallRisk: "HIGH",
      modelRisk: "LOW",
      model: config.llmParamProfile.model,
      promptVersion: PROMPT_VERSION,
      inputTokens: 500,
      outputTokens: 150,
      retryCount: 0,
      discardedFindings: 0,
      errorCode: null,
    });
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.providerRequestId).toMatch(/^req_mock_/);
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.findings).toHaveLength(1);
  });

  it("sends the stored document text to the provider, with the request's correlation id", async () => {
    const { document, cookie } = await ownedDocument();

    const res = await analyze(testServer(), document.id, cookie).set(
      "X-Request-Id",
      "01J9TESTCORRELATION",
    );

    expect(res.status).toBe(200);
    expect(mockProvider().calls).toHaveLength(1);
    expect(mockProvider().calls[0]).toMatchObject({
      documentText: CONTRACT,
      requestId: "01J9TESTCORRELATION",
    });
  });

  it("writes model and promptVersion at insert, while the analysis is still PENDING", async () => {
    const { document, cookie } = await ownedDocument();
    mockProvider().scriptValidResponse({}, { delayMs: 400 });

    const inFlight = analyze(testServer(), document.id, cookie).then((res) => res);
    const row = await waitFor(() =>
      prisma.analysis.findFirst({ where: { documentId: document.id } }),
    );

    expect(row).toMatchObject({
      status: "PENDING",
      model: config.llmParamProfile.model,
      promptVersion: PROMPT_VERSION,
    });
    expect((await inFlight).status).toBe(200);
  });

  it("treats an empty findings array as a clean contract: COMPLETED, overallRisk LOW (FR-3.4)", async () => {
    const { document, cookie } = await ownedDocument();
    mockProvider().scriptValidResponse({ overall_risk: "medium", findings: [] });

    const res = await analyze(testServer(), document.id, cookie);

    expect(res.status).toBe(200);
    expect(res.body.analysis).toMatchObject({
      status: "COMPLETED",
      overallRisk: "LOW",
      findings: [],
      discardedFindings: 0,
    });
  });

  it("drops unverifiable findings, counts them, and derives risk from the survivors only", async () => {
    const { document, cookie } = await ownedDocument();
    mockProvider().scriptValidResponse({
      findings: [
        finding("high", FABRICATED[0]),
        finding("low", EXCERPTS.payment, "payment"),
      ],
    });

    const res = await analyze(testServer(), document.id, cookie);

    expect(res.status).toBe(200);
    expect(res.body.analysis.overallRisk).toBe("LOW");
    expect(res.body.analysis.findings.map((item) => item.clauseExcerpt)).toEqual([
      EXCERPTS.payment,
    ]);
    expect(res.body.analysis.discardedFindings).toBe(1);
    const [row] = await analysesOf(document.id);
    expect(row.discardedFindings).toBe(1);
    expect(row.findings).toHaveLength(1);
  });

  it("is not blocked by an earlier COMPLETED analysis — only PENDING is guarded", async () => {
    const { document, cookie } = await ownedDocument();
    await createAnalysis({ documentId: document.id });

    expect((await analyze(testServer(), document.id, cookie)).status).toBe(200);
    expect(await analysesOf(document.id)).toHaveLength(2);
  });
});

describe("TR-4 — ownership (FR-1.5)", () => {
  it("returns 404, never 403, for another user's document, before any row or provider call", async () => {
    const { document } = await ownedDocument();
    const intruder = await ownedDocument();

    const res = await analyze(testServer(), document.id, intruder.cookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(mockProvider().calls).toHaveLength(0);
    expect(await analysesOf(document.id)).toHaveLength(0);
  });

  it("returns the same 404 for a document that does not exist", async () => {
    const { cookie } = await ownedDocument();

    const res = await analyze(testServer(), "cm0doesnotexist0000000000", cookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("requires a session", async () => {
    const { document } = await ownedDocument();

    const res = await request(testServer())
      .post(`/api/v1/documents/${document.id}/analyze`)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(401);
    expect(mockProvider().calls).toHaveLength(0);
  });
});

describe("TR-5 — invalid model output (FR-3.2)", () => {
  it("retries exactly once with the correction, then 502 LLM_INVALID_OUTPUT, FAILED with both calls' tokens", async () => {
    const { document, cookie } = await ownedDocument();
    // The third, valid script proves there is no second retry: it is never consumed.
    mockProvider().scriptMalformedJson().scriptMalformedJson().scriptValidResponse();

    const res = await analyze(testServer(), document.id, cookie);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("LLM_INVALID_OUTPUT");
    const { calls } = mockProvider();
    expect(calls).toHaveLength(2);
    expect(calls[0].correction).toBeUndefined();
    expect(calls[1].correction.invalidResponse).toContain('"document_type": "Broken"');
    expect(calls[1].correction.errorSummary).toMatch(/^not valid JSON \(/);

    const [row] = await analysesOf(document.id);
    expect(row).toMatchObject({
      status: "FAILED",
      errorCode: "LLM_INVALID_OUTPUT",
      inputTokens: 1000,
      outputTokens: 300,
      retryCount: 1,
      promptVersion: PROMPT_VERSION,
    });
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.findings).toHaveLength(0);
  });

  it("succeeds when the one retry returns valid output, counting both calls", async () => {
    const { document, cookie } = await ownedDocument();
    mockProvider().scriptSchemaInvalid({ reason: "extra_key" }).scriptValidResponse();

    const res = await analyze(testServer(), document.id, cookie);

    expect(res.status).toBe(200);
    const [row] = await analysesOf(document.id);
    expect(row).toMatchObject({
      status: "COMPLETED",
      retryCount: 1,
      inputTokens: 1000,
      outputTokens: 300,
    });
  });
});

describe("TR-7 — every excerpt fails verification (FR-3.4)", () => {
  it("fails 502 ALL_FINDINGS_DISCARDED and never presents a clean report", async () => {
    const { document, cookie } = await ownedDocument();
    mockProvider().scriptFabricatedExcerpts(FABRICATED);

    const res = await analyze(testServer(), document.id, cookie);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("ALL_FINDINGS_DISCARDED");
    const [row] = await analysesOf(document.id);
    expect(row).toMatchObject({
      status: "FAILED",
      errorCode: "ALL_FINDINGS_DISCARDED",
      discardedFindings: 2,
      overallRisk: null,
      inputTokens: 500,
      outputTokens: 150,
    });
    expect(row.findings).toHaveLength(0);

    const read = await request(testServer())
      .get(`/api/v1/documents/${document.id}`)
      .set("Cookie", cookie);
    expect(read.body.analysis.status).toBe("FAILED");
  });
});

describe("provider timeout (FR-3.6)", () => {
  it("fails 504 LLM_TIMEOUT and still persists the FAILED analysis with its duration", async () => {
    const { document, cookie } = await ownedDocument();
    mockProvider().scriptTimeout();

    const res = await analyze(testServer(), document.id, cookie);

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe("LLM_TIMEOUT");
    const [row] = await analysesOf(document.id);
    expect(row).toMatchObject({
      status: "FAILED",
      errorCode: "LLM_TIMEOUT",
      retryCount: 0,
      inputTokens: null,
      outputTokens: null,
    });
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("TR-8 — one PENDING analysis per document (FR-3.8)", () => {
  it("returns 409 ANALYSIS_IN_PROGRESS while an analysis is PENDING, without calling the provider", async () => {
    const { document, cookie } = await ownedDocument();
    await createAnalysis({
      documentId: document.id,
      status: "PENDING",
      completedAt: null,
    });

    const res = await analyze(testServer(), document.id, cookie);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ANALYSIS_IN_PROGRESS");
    expect(mockProvider().calls).toHaveLength(0);
    expect(await analysesOf(document.id)).toHaveLength(1);
  });

  it("lets exactly one of two simultaneous requests through, against one live server", async () => {
    const { document, cookie } = await ownedDocument();
    // Holds the winner's provider call open, so the other request arrives
    // while its analysis is still PENDING.
    mockProvider().scriptValidResponse({}, { delayMs: 300 });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const responses = await Promise.all([
        analyze(server, document.id, cookie),
        analyze(server, document.id, cookie),
      ]);

      expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(responses.find((res) => res.status === 409)?.body.error.code).toBe(
        "ANALYSIS_IN_PROGRESS",
      );
      expect(mockProvider().calls).toHaveLength(1);
      expect((await analysesOf(document.id)).map((row) => row.status)).toEqual([
        "COMPLETED",
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("TR-20 — COMPLETED and its findings commit together (FR-3.13)", () => {
  /**
   * Lets the analysis update run inside the real transaction, then fails the
   * finding insert. It fails outside a transaction too, so an implementation
   * without one cannot slip past.
   *
   * @param {Error} crash
   */
  function crashFindingInsert(crash) {
    const client = /** @type {any} */ (prisma);
    const realTransaction = client.$transaction.bind(client);
    /**
     * @param {(tx: any) => Promise<unknown>} work
     * @param {unknown} [options]
     */
    const transactionWithCrashingFindingInsert = (work, options) =>
      realTransaction(
        (tx) =>
          work(
            new Proxy(tx, {
              get: (target, property) =>
                property === "finding"
                  ? { createMany: () => Promise.reject(crash) }
                  : Reflect.get(target, property),
            }),
          ),
        options,
      );
    /** @type {any} */ (vi.spyOn(client, "$transaction")).mockImplementation(
      transactionWithCrashingFindingInsert,
    );
    vi.spyOn(client.finding, "createMany").mockRejectedValue(crash);
  }

  function scriptTwoFindings() {
    mockProvider().scriptValidResponse({
      findings: [
        finding("high", EXCERPTS.ownership, "ip"),
        finding("medium", EXCERPTS.revisions),
      ],
    });
  }

  it("a crash between completion and finding insertion leaves no COMPLETED analysis with zero findings", async () => {
    const { document, cookie } = await ownedDocument();
    scriptTwoFindings();
    crashFindingInsert(
      new Error("simulated crash between completion and finding insertion"),
    );
    // A crashed process records nothing afterwards, so the failure record is
    // made to fail as well. Otherwise the FAILED write would overwrite a
    // COMPLETED row that had already committed, and hide a missing
    // transaction.
    const client = /** @type {any} */ (prisma);
    const realUpdate = client.analysis.update.bind(client.analysis);
    /** @type {any} */ (vi.spyOn(client.analysis, "update")).mockImplementation(
      /** @param {any} args */
      (args) =>
        args?.data?.status === "FAILED"
          ? Promise.reject(new Error("the process is gone"))
          : realUpdate(args),
    );

    const res = await analyze(testServer(), document.id, cookie);

    expect(res.status).toBe(500);
    const rows = await analysesOf(document.id);
    expect(
      rows.filter((row) => row.status === "COMPLETED" && row.findings.length === 0),
    ).toEqual([]);
    // What a crash leaves behind: still PENDING, for the stale-analysis
    // reaper to mark FAILED (FR-3.8, §12.3).
    expect(rows.map((row) => row.status)).toEqual(["PENDING"]);
  });

  it("records an unexpected failure while persisting as FAILED, errorCode INTERNAL, with no findings", async () => {
    const { document, cookie } = await ownedDocument();
    scriptTwoFindings();
    crashFindingInsert(new Error("simulated database failure during finding insertion"));

    const res = await analyze(testServer(), document.id, cookie);

    expect(res.status).toBe(500);
    const rows = await analysesOf(document.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "FAILED", errorCode: "INTERNAL" });
    expect(rows[0].findings).toEqual([]);
  });
});
