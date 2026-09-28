import { describe, expect, it } from "vitest";
import request from "supertest";
import { register } from "prom-client";
import config from "../../src/config.js";
import prisma from "../../src/lib/prisma.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { countWords } from "../../src/services/extraction.js";
import { createAnalysis, createDocument, createUser } from "./factories.js";
import { testServer } from "./testServer.js";

/**
 * BUILD-PLAN step 68, item 3: the two Sev-1 alerts fire on conditions the
 * pipeline structurally prevents, so they cannot be drilled without a way to
 * plant the condition. This exercises both the DETECTION on the ordinary
 * request path and the staging-only drill routes that force it
 * (src/routes/drills.js, which says what each drill does and does not prove).
 */

const CONTRACT = [
  "DESIGN SERVICES AGREEMENT",
  "1. Revisions. The Client may request unlimited revisions at no additional cost.",
  "2. Payment. Invoices are payable within ninety (90) days of receipt.",
].join("\n\n");
const REAL_EXCERPT = "Invoices are payable within ninety (90) days of receipt.";
const NOT_IN_CONTRACT = "The Designer shall surrender all rights in perpetuity to any third party.";

const DRILL_TOKEN = /** @type {string} */ (config.ALERT_DRILL_TOKEN);

/** @param {string} name @param {Record<string, string>} [labels] */
async function counterValue(name, labels = {}) {
  const metric = /** @type {import("prom-client").Metric} */ (register.getSingleMetric(name));
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([key, want]) => v.labels[key] === want))
    .reduce((total, v) => total + v.value, 0);
}

async function reportReadyUser() {
  const user = await createUser();
  const document = await createDocument({
    userId: user.id,
    rawText: CONTRACT,
    wordCount: countWords(CONTRACT),
  });
  const analysis = await createAnalysis({
    documentId: document.id,
    status: "COMPLETED",
    overallRisk: "MEDIUM",
    summary: "A short summary of the agreement, long enough to be plausible.",
  });
  await prisma.finding.create({
    data: {
      analysisId: analysis.id,
      category: "PAYMENT",
      severity: "MEDIUM",
      clauseExcerpt: REAL_EXCERPT,
      explanation: "Ninety days is a long time to wait for money you are owed.",
      suggestedChange: "Ask for payment within fourteen days of the invoice.",
    },
  });
  const cookie = `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`;
  return { user, document, analysis, cookie };
}

const readReport = (documentId, cookie) =>
  request(testServer()).get(`/api/v1/documents/${documentId}`).set("Cookie", cookie);

describe("unverified_excerpt_displayed — the detection on the ordinary read path", () => {
  it("serves a report whose excerpts are all in the document, and counts nothing", async () => {
    const { document, cookie } = await reportReadyUser();
    const before = await counterValue("unverified_excerpt_displayed_total");

    const res = await readReport(document.id, cookie);

    expect(res.status).toBe(200);
    expect(res.body.analysis.findings).toHaveLength(1);
    expect(await counterValue("unverified_excerpt_displayed_total")).toBe(before);
  });

  it("refuses the report when a stored finding's excerpt is not in its document", async () => {
    // Written straight to the table, which is how this could really happen:
    // a migration, or a later feature that does not go through
    // services/analysis.js.
    const { document, analysis, cookie } = await reportReadyUser();
    await prisma.finding.create({
      data: {
        analysisId: analysis.id,
        category: "IP",
        severity: "HIGH",
        clauseExcerpt: NOT_IN_CONTRACT,
        explanation: "This did not come from the document.",
        suggestedChange: "Nothing to ask for; this clause does not exist.",
      },
    });
    const before = await counterValue("unverified_excerpt_displayed_total", { path: "report" });

    const res = await readReport(document.id, cookie);

    // Nothing is served: not the fabricated finding, and not the real one
    // beside it either.
    expect(res.status).toBe(500);
    expect(res.body.analysis).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("perpetuity");
    expect(res.body.error.code).toBe("INTERNAL");
    expect(res.body.error.requestId).toBeTruthy();
    expect(await counterValue("unverified_excerpt_displayed_total", { path: "report" })).toBe(
      before + 1,
    );
  });

  it("counts one per unverifiable finding, not one per request", async () => {
    const { document, analysis, cookie } = await reportReadyUser();
    for (const excerpt of [NOT_IN_CONTRACT, "Another sentence that is nowhere in the contract."]) {
      await prisma.finding.create({
        data: {
          analysisId: analysis.id,
          category: "OTHER",
          severity: "LOW",
          clauseExcerpt: excerpt,
          explanation: "Not from the document.",
          suggestedChange: "Not applicable.",
        },
      });
    }
    const before = await counterValue("unverified_excerpt_displayed_total", { path: "report" });

    await readReport(document.id, cookie);

    expect(await counterValue("unverified_excerpt_displayed_total", { path: "report" })).toBe(
      before + 2,
    );
  });
});

describe("cross_user_access — the detection", () => {
  it("does not fire on the ordinary path, because the query cannot return another user's row", async () => {
    const { document } = await reportReadyUser();
    const stranger = await createUser();
    const strangerCookie = `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: stranger.id, tokenVersion: stranger.tokenVersion })}`;
    const before = await counterValue("cross_user_access_total");

    const res = await readReport(document.id, strangerCookie);

    // FR-1.5: 404, and the alert stays quiet — nothing was loaded to assert
    // over. A 404 here is the filter working, not the assertion working.
    expect(res.status).toBe(404);
    expect(await counterValue("cross_user_access_total")).toBe(before);
  });
});

describe("the staging-only drill routes (step 68, item 3)", () => {
  /** @param {string} path @param {object} body @param {string} [token] */
  const drill = (path, body, token = DRILL_TOKEN) => {
    const req = request(testServer()).post(`/api/v1/drills/${path}`).set("Content-Type", "application/json");
    if (token) req.set("X-Alert-Drill", token);
    return req.send(body);
  };

  it("are mounted here, because the drill token is set in the test environment", () => {
    expect(config.ALERT_DRILL_TOKEN).toBeTruthy();
    expect(config.isProduction).toBe(false);
  });

  it.each([
    ["no token", ""],
    ["a wrong token", "x".repeat(40)],
  ])("refuse %s", async (_label, token) => {
    const { document } = await reportReadyUser();
    const res = await drill("unverified-excerpt", { documentId: document.id }, token);
    expect(res.status).toBe(401);
  });

  it("fires unverified_excerpt_displayed end to end, then removes the planted row", async () => {
    const { document, analysis } = await reportReadyUser();
    const before = await counterValue("unverified_excerpt_displayed_total");

    const res = await drill("unverified-excerpt", { documentId: document.id });

    // A 500 is the drill succeeding: the assertion refused to serve.
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL");
    expect(await counterValue("unverified_excerpt_displayed_total")).toBe(before + 1);

    // And it cleaned up after itself, so the report reads normally again.
    const findings = await prisma.finding.findMany({ where: { analysisId: analysis.id } });
    expect(findings).toHaveLength(1);
    expect(findings[0].clauseExcerpt).toBe(REAL_EXCERPT);
  });

  it("fires cross_user_access", async () => {
    const { document } = await reportReadyUser();
    const stranger = await createUser();
    const before = await counterValue("cross_user_access_total");

    const res = await drill("cross-user-access", {
      documentId: document.id,
      subjectId: stranger.id,
    });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL");
    expect(await counterValue("cross_user_access_total")).toBe(before + 1);
  });

  it("does not fire cross_user_access when the subject IS the owner", async () => {
    // The drill route's own negative control: it reads without an owner
    // filter, so if the assertion were inverted this is where it would show.
    const { document, user } = await reportReadyUser();
    const before = await counterValue("cross_user_access_total");

    const res = await drill("cross-user-access", { documentId: document.id, subjectId: user.id });

    // 500 with `fired: false` is the drill reporting that the detection did
    // NOT fire, which for this input is correct.
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ drill: "cross_user_access", fired: false });
    expect(await counterValue("cross_user_access_total")).toBe(before);
  });

  it("404s for a document that does not exist, planting nothing", async () => {
    const res = await drill("unverified-excerpt", { documentId: "does-not-exist" });
    expect(res.status).toBe(404);
  });
});
