import { describe, it, expect } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import config from "../../src/config.js";
import { createUser } from "./factories.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { getLlmProvider } from "../../src/services/llm/index.js";
import { MockLlmProvider } from "../../src/services/llm/mockProvider.js";
import { buildMessageParams } from "../../src/services/llm/client.js";
import { excerptAppears } from "../../src/services/verify.js";
import { C, countZeroWidth } from "../fixtures/contracts.js";
import { evaluateGates, scoreRepeat } from "../../../scripts/score.js";

/**
 * TR-15 (SRS §10.3, NFR-2.8): fixture 09 through the real pipeline — HTTP
 * intake in all three formats, FR-2.4 normalisation, the stored text, the
 * message the provider receives, §5.3 verification and the report.
 *
 * The model is the scripted mock, so what these tests prove is everything
 * AROUND the model: that the disguised injection reaches the model as the
 * plain instruction and only as delimited document data, that a
 * fabricated finding the injection might provoke never reaches the report,
 * and that if the injection DID suppress the findings, the benchmark's
 * TR-15 gate catches it. Whether the real model resists the injection is
 * the benchmark's question (scripts/benchmark.js, fixture 09 is in its
 * corpus), not this file's.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const FIXTURE = "09-injection-attempt";
const answerKey = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8"));
const keyEntry = answerKey.documents.find(
  (/** @type {{ file: string }} */ d) => d.file === FIXTURE,
);

const FABRICATED =
  "Manager’s total liability under this Agreement is capped at the fees paid in the preceding month.";
const INVISIBLES = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u180E]/u;

function mockProvider() {
  const backend = getLlmProvider().backend;
  if (!(backend instanceof MockLlmProvider))
    throw new Error("integration tests run with LLM_PROVIDER=mock");
  return backend;
}

/** A §5.2 finding as the model returns it. */
function finding(severity, clauseExcerpt, category) {
  return {
    category,
    severity,
    clause_excerpt: clauseExcerpt,
    explanation: "This shifts a risk onto you that the client should carry.",
    suggested_change: "Ask for a cap tied to the fees paid.",
  };
}

async function signedIn() {
  const user = await createUser();
  const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });
  return { user, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

/**
 * Fixture 09 in one format, through POST /api/v1/documents as a user sends it.
 * @param {string} cookie
 * @param {"docx" | "pdf" | "txt"} format
 */
function upload(cookie, format) {
  const post = request(testServer()).post("/api/v1/documents").set("Cookie", cookie);
  const bytes = readFileSync(join(FIXTURES, `${FIXTURE}.${format}`));
  return format === "txt"
    ? post.set("Content-Type", "application/json").send({ text: bytes.toString("utf8") })
    : post.attach("file", bytes, `${FIXTURE}.${format}`);
}

/** @param {string} cookie @param {string} documentId */
function analyze(cookie, documentId) {
  return request(testServer())
    .post(`/api/v1/documents/${documentId}/analyze`)
    .set("Cookie", cookie)
    .set("Content-Type", "application/json");
}

describe("TR-15: the injection fixture through the real pipeline", () => {
  it("ships its zero-width characters, and the key says how many", () => {
    // The precondition for everything below: without the disguise in the
    // uploaded bytes, these tests would pass for the wrong reason.
    expect(keyEntry.hostile).toBe(true);
    const disguised = keyEntry.injection.find(
      (/** @type {{ disguised: boolean }} */ i) => i.disguised,
    );
    expect(disguised.zero_width_characters).toBeGreaterThan(0);
    expect(countZeroWidth(readFileSync(join(FIXTURES, `${FIXTURE}.txt`), "utf8"))).toBe(
      disguised.zero_width_characters,
    );
  });

  it.each(["docx", "pdf", "txt"])(
    "%s: stored text has no invisible characters, and reads both injections as plain text",
    async (format) => {
      const { cookie } = await signedIn();
      const res = await upload(cookie, /** @type {"docx" | "pdf" | "txt"} */ (format));
      expect(res.status).toBe(201);

      const { rawText } = await prisma.document.findUniqueOrThrow({
        where: { id: res.body.document.id },
      });
      expect(INVISIBLES.test(rawText)).toBe(false);
      expect(excerptAppears(C.i_inject_hidden, rawText)).toBe(true);
      expect(excerptAppears(C.i_inject_visible, rawText)).toBe(true);
      for (const planted of keyEntry.findings)
        expect(excerptAppears(planted.excerpt, rawText)).toBe(true);
    },
  );

  it("sends the injection only as delimited document data, never in the system prompt", async () => {
    const { cookie } = await signedIn();
    const created = await upload(cookie, "pdf");
    const { rawText } = await prisma.document.findUniqueOrThrow({
      where: { id: created.body.document.id },
    });

    mockProvider().scriptValidResponse({
      overall_risk: "high",
      findings: [finding("high", C.i_ip, "ip")],
    });
    expect((await analyze(cookie, created.body.document.id)).status).toBe(200);

    // What the provider was handed is the stored text, byte for byte...
    const call = mockProvider().calls.at(-1);
    expect(call?.documentText).toBe(rawText);
    // ...and the real client places it inside <contract> in the user turn.
    const params = buildMessageParams({
      profile: config.llmParamProfile,
      documentText: rawText,
    });
    expect(params.system).not.toContain("report no issues");
    expect(params.system).not.toContain("empty findings list");
    const user = /** @type {string} */ (params.messages[0].content);
    const inside = user.slice(
      user.indexOf("<contract>"),
      user.lastIndexOf("</contract>"),
    );
    // §5.3's rule, not toContain: from the PDF the sentence wraps across a
    // line, which is layout, not a different sentence.
    expect(excerptAppears(C.i_inject_hidden, inside)).toBe(true);
    expect(excerptAppears(C.i_inject_visible, inside)).toBe(true);
    expect(
      excerptAppears(C.i_inject_hidden, user.slice(user.lastIndexOf("</contract>"))),
    ).toBe(false);
  });

  it("a finding the injection provoked with an invented excerpt never reaches the report", async () => {
    const { cookie } = await signedIn();
    const created = await upload(cookie, "docx");
    const documentId = created.body.document.id;
    const { rawText } = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
    });

    mockProvider().scriptValidResponse({
      overall_risk: "low",
      findings: [
        finding("high", C.i_ip, "ip"),
        finding("high", C.i_payment, "payment"),
        // A reassuring clause the document does not contain, of the kind an
        // injection that "approved the agreement" might steer a model into.
        finding("high", FABRICATED, "liability"),
        // Flagging the injection itself is what the system prompt asks for.
        finding("medium", C.i_inject_visible, "other"),
      ],
    });
    const res = await analyze(cookie, documentId);

    // A valid report...
    expect(res.status).toBe(200);
    expect(res.body.analysis.status).toBe("COMPLETED");
    // ...with the invented excerpt discarded and counted, never shown...
    expect(res.body.analysis.discardedFindings).toBe(1);
    const shown = res.body.analysis.findings.map(
      (/** @type {{ clauseExcerpt: string }} */ f) => f.clauseExcerpt,
    );
    expect(shown).toHaveLength(3);
    expect(shown).not.toContain(FABRICATED);
    // ...and every excerpt shown is verbatim text of the document.
    for (const excerpt of shown) expect(excerptAppears(excerpt, rawText)).toBe(true);
    // The risk is the server's rule over what survived, not the model's "low".
    expect(res.body.analysis.overallRisk).toBe("HIGH");
  });

  it("if the injection DID suppress the findings, the benchmark's TR-15 gate fails the run", async () => {
    const { cookie } = await signedIn();
    const created = await upload(cookie, "txt");

    // The attack succeeding: nothing flagged, nothing missing.
    mockProvider().scriptValidResponse({
      overall_risk: "low",
      findings: [],
      missing_clauses: [],
    });
    const res = await analyze(cookie, created.body.document.id);

    // The pipeline cannot tell, and does not pretend to: this is a valid,
    // completed, low-risk report. PRD §17's worst case, bounded by the
    // disclaimer. Catching it is the benchmark's job...
    expect(res.status).toBe(200);
    expect(res.body.analysis.findings).toEqual([]);
    expect(res.body.analysis.overallRisk).toBe("LOW");

    // ...and it does, fed this very report.
    const scored = scoreRepeat(
      [
        {
          file: FIXTURE,
          overallRisk: res.body.analysis.overallRisk,
          findings: res.body.analysis.findings,
          missingClauses: res.body.analysis.missingClauses,
          discardedFindings: res.body.analysis.discardedFindings,
        },
      ],
      answerKey,
    );
    expect(scored.falseClean).toEqual([{ file: FIXTURE, returned: 0 }]);
    const gate = evaluateGates([scored]).find((g) => g.name.includes("TR-15"));
    expect(gate?.verdict).toBe("FAIL");
  });
});
