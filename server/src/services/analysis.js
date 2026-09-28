import config from "../config.js";
import { AppError } from "../lib/AppError.js";
import { loadOwnedDocument } from "../lib/ownership.js";
import prisma from "../lib/prisma.js";
import { mapPendingAnalysisConflict } from "../lib/prismaErrors.js";
import { getRequestId } from "../middleware/requestId.js";
import logger from "../observability/logger.js";
import {
  analysisDuration,
  analysisFindingsDiscardedTotal,
  analysisFindingsTotal,
  analysisRiskDriftTotal,
  analysisTotal,
  llmTokensTotal,
} from "../observability/metrics.js";
import { withSpan } from "../observability/tracing.js";
import { assertExcerptsVerified } from "../lib/defensiveAssertions.js";
import { PROMPT_VERSION } from "../prompts/analyze.js";
import { parseAnalysisResult } from "../schemas/analysisResult.js";
import { getLlmProvider } from "./llm/index.js";
import { assertWithinQuota, consumeQuota } from "./quota.js";
import { deriveOverallRisk } from "./risk.js";
import { assertAnalysisAllowed, recordSpend } from "./spend.js";
import { normalizeForMatch, verifyFindings } from "./verify.js";

/**
 * SRS §2.2 — the analyze sequence, run synchronously (FR-3.7) in the order
 * the spec gives it. The order is load-bearing: ownership comes before the
 * quota check, so a quota response cannot reveal that another user's
 * document exists, and both come before the PENDING guard and any LLM
 * spend — refusing on quota after paying the provider would defeat the
 * point of having one.
 *
 * Every terminal state, failures included, writes the analysis row with its
 * instrumentation (FR-3.5): cost and failure rate are only measurable if a
 * failed call leaves a record.
 */

/**
 * @typedef {import("../schemas/analysisResult.js").FindingData} FindingData
 * @typedef {{ inputTokens: number | null, outputTokens: number | null, retryCount: number, providerRequestId: string | null, discardedFindings: number }} Instrumentation
 */

/** §5.2's lowercase values to Prisma's enums, spelled out so a rename fails at typecheck. */
/** @type {Record<"low" | "medium" | "high", import("@prisma/client").Risk>} */
const RISK = { low: "LOW", medium: "MEDIUM", high: "HIGH" };
/** @type {Record<FindingData["severity"], import("@prisma/client").Severity>} */
const SEVERITY = { low: "LOW", medium: "MEDIUM", high: "HIGH" };
/** @type {Record<FindingData["category"], import("@prisma/client").Category>} */
const CATEGORY = {
  payment: "PAYMENT",
  ip: "IP",
  scope: "SCOPE",
  termination: "TERMINATION",
  liability: "LIABILITY",
  confidentiality: "CONFIDENTIALITY",
  dispute: "DISPUTE",
  other: "OTHER",
};

/**
 * The whole sequence inside one `analysis` span (§6.6), the parent of the
 * stage spans below.
 *
 * @param {{ documentId: string, userId: string }} input
 */
export function analyzeDocument(input) {
  return withSpan("analysis", (span) => analyzeDocumentInSpan(input, span));
}

/**
 * @param {{ documentId: string, userId: string }} input
 * @param {import("@opentelemetry/api").Span} span
 */
async function analyzeDocumentInSpan({ documentId, userId }, span) {
  // Step 1. requireAuth has authenticated the request and refused a
  // SUSPENDED account; ownership is checked here, 404 and never 403 (FR-1.5).
  const document = await loadOwnedDocument(documentId, userId);

  // Step 1, continued. FR-1.7 / PRD D4: an UNVERIFIED account gets 403
  // EMAIL_NOT_VERIFIED here, before quota and before any spend.
  //
  // This is the ONLY place the check lives. It is deliberately not in auth
  // middleware: D4's reasoning is that friction belongs where the cost is —
  // an LLM call and a stored confidential document — and an unverified
  // user may sign in, browse and upload. Putting it in the door would
  // lock them out of everything to protect one endpoint, and would catch a
  // mistyped address later than this does, when the user is still in the
  // flow and can fix it.
  //
  // After ownership on purpose: a response that depended on verification
  // state BEFORE the document was resolved would let one user probe
  // whether another's document id exists.
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { state: true },
  });
  if (account?.state === "UNVERIFIED") throw new AppError("EMAIL_NOT_VERIFIED");

  // Step 2. Platform state, then per-user quota (§3.5) — after ownership,
  // so neither response can reveal that another user's document exists,
  // and before the PENDING insert and any provider spend.
  //
  // The platform check goes FIRST for honesty, not cost: a user who is
  // over their own quota while the platform is also capped must not be
  // told they used their fifty analyses.
  await assertAnalysisAllowed();
  await assertWithinQuota(userId);

  // Steps 3 and 4 are one statement. The partial unique index
  // analysis_one_pending_per_document is the guard (FR-3.8); a read before
  // this insert would be a race between instances, so there is none. model
  // and promptVersion are written now, while PENDING, so even a failed
  // analysis records what was asked (FR-3.14).
  let analysis;
  try {
    analysis = await prisma.analysis.create({
      data: {
        documentId: document.id,
        status: "PENDING",
        model: config.llmParamProfile.model,
        promptVersion: PROMPT_VERSION,
      },
    });
  } catch (err) {
    throw mapPendingAnalysisConflict(err);
  }
  span.setAttribute("analysis.id", analysis.id);

  const startedAt = Date.now();
  /** @type {Instrumentation} */
  const record = {
    inputTokens: null,
    outputTokens: null,
    retryCount: 0,
    providerRequestId: null,
    discardedFindings: 0,
  };

  // Step 11. Usage and spend counters (§3.5, FR-5.2). They count every
  // terminal outcome, FAILURES INCLUDED — a failed provider call still consumed
  // provider tokens, so a quota that only counted successes would be a
  // free retry loop: fail, retry, fail, retry, unmetered and billed. That
  // is why the increment is in the `finally` below and not in the success
  // branch, which is where it would naturally have gone.
  try {
    const completed = await runAnalysis(document, analysis.id, record, startedAt);
    logOutcome(
      document,
      completed.id,
      "COMPLETED",
      null,
      record,
      completed.durationMs,
      completed.findings.length,
    );
    recordAnalysisMetrics({ record, durationMs: completed.durationMs ?? 0, completed });
    return completed;
  } catch (err) {
    const errorCode = err instanceof AppError ? err.code : "INTERNAL";
    const durationMs = Date.now() - startedAt;
    try {
      await prisma.analysis.update({
        where: { id: analysis.id },
        data: {
          status: "FAILED",
          errorCode,
          ...record,
          durationMs,
          completedAt: new Date(),
        },
      });
    } catch (persistErr) {
      // The original failure is what the user gets; losing its record is
      // logged, never allowed to replace it.
      logger.error(
        { err: persistErr, analysis: { id: analysis.id } },
        "could not record failed analysis",
      );
    }
    logOutcome(document, analysis.id, "FAILED", errorCode, record, durationMs, 0);
    recordAnalysisMetrics({ record, durationMs, errorCode });
    throw err;
  } finally {
    // FR-5.2, and the reason this is a `finally`: the analysis reached a
    // terminal state either way, and either way it spent provider tokens.
    // Neither of these throws, so metering cannot turn a served report
    // into an error or replace the original failure with a bookkeeping
    // one. `record` carries whatever token counts the call produced,
    // including the partial counts of a failed one.
    await Promise.all([consumeQuota(userId), recordSpend(record)]);
  }
}

/**
 * Steps 5 to 10, for an analysis already inserted as PENDING.
 *
 * @param {{ id: string, rawText: string }} document
 * @param {string} analysisId
 * @param {Instrumentation} record
 * @param {number} startedAt
 */
async function runAnalysis(document, analysisId, record, startedAt) {
  const provider = getLlmProvider();
  const requestId = getRequestId();

  /**
   * FR-3.10's total ceiling, created ONCE for the whole operation and
   * shared by both retry budgets — the transport retries inside each
   * provider call, and FR-3.2's single schema retry below. The spec is
   * explicit that the two "do not compose beyond a total 90-second
   * ceiling", and a deadline is what makes that true: a ceiling enforced
   * inside the retry layer would hand each schema retry a fresh ninety
   * seconds, which is exactly the composition being forbidden.
   *
   * KNOWN AND ACCEPTED EDGE (NFR-3.5): the graceful-shutdown drain is
   * also 90 seconds, so it equals this worst case rather than exceeding
   * it. An analysis that starts immediately before SIGTERM and then uses
   * its entire budget can still be cut off at the drain boundary. Widening
   * the drain would only move the boundary, since the ceiling is what the
   * platform proxy timeout is sized against; the honest answer is that
   * this is a narrow window, it fails as a normal analysis failure with a
   * recorded row, and the user can retry.
   */
  const deadlineAt = startedAt + config.timeouts.analyzeCeiling;

  // Steps 5 and 6. One retry on invalid output, with Appendix A's correction
  // appended to the same conversation. One, not a loop.
  const first = await provider.analyze({
    documentText: document.rawText,
    requestId,
    deadlineAt,
  });
  addUsage(record, first);
  let parsed = await withSpan("analysis.validate", () =>
    parseAnalysisResult(first.rawText),
  );
  if (!parsed.success) {
    record.retryCount = 1;
    const second = await provider.analyze({
      documentText: document.rawText,
      requestId,
      deadlineAt,
      correction: { invalidResponse: first.rawText, errorSummary: parsed.errorSummary },
    });
    addUsage(record, second);
    parsed = await withSpan(
      "analysis.validate",
      () => parseAnalysisResult(second.rawText),
      {
        "analysis.schema_retry": true,
      },
    );
    if (!parsed.success) throw new AppError("LLM_INVALID_OUTPUT");
  }
  const result = parsed.data;

  // Step 7. The document is normalised once, for every excerpt (§5.3).
  const { verified, discardedCount } = await withSpan("analysis.verify", (span) => {
    const outcome = verifyFindings(result.findings, normalizeForMatch(document.rawText));
    span.setAttributes({
      "analysis.findings_reported": result.findings.length,
      "analysis.findings_discarded": outcome.discardedCount,
    });
    return outcome;
  });
  record.discardedFindings = discardedCount;

  // Step 8. Findings reported and every one discarded is a hallucinated
  // report, never a clean contract (FR-3.4). An empty findings array is a
  // clean contract, and proceeds.
  if (result.findings.length > 0 && verified.length === 0) {
    throw new AppError("ALL_FINDINGS_DISCARDED");
  }

  // Step 9. The rule decides the risk a user sees; the model's own claim is
  // kept only to measure drift (FR-3.9, PRD D7).
  const overallRisk = deriveOverallRisk(verified);
  const durationMs = Date.now() - startedAt;

  // Step 10. COMPLETED and every finding commit together or not at all
  // (FR-3.13): a completed analysis missing its findings reads as a clean
  // contract. Step 12's ordering happens where the report is serialized.
  const persisted = await withSpan("analysis.persist", () =>
    prisma.$transaction(async (tx) => {
      await tx.analysis.update({
        where: { id: analysisId },
        data: {
          status: "COMPLETED",
          overallRisk,
          modelRisk: RISK[result.overall_risk],
          summary: result.summary,
          missingClauses: result.missing_clauses,
          ...record,
          durationMs,
          completedAt: new Date(),
        },
      });
      await tx.finding.createMany({
        data: verified.map((finding) => ({
          analysisId,
          category: CATEGORY[finding.category],
          severity: SEVERITY[finding.severity],
          clauseExcerpt: finding.clause_excerpt,
          explanation: finding.explanation,
          suggestedChange: finding.suggested_change,
        })),
      });
      return tx.analysis.findUniqueOrThrow({
        where: { id: analysisId },
        include: { findings: true },
      });
    }),
  );
  // PRD §11.1 / Appendix C's unverified_excerpt_displayed. Redundant here
  // by construction — these are the findings verifyFindings just admitted —
  // and asserted anyway, because "every excerpt displayed" has no exception
  // for the one that was verified a moment ago, and because the row that
  // gets served is the one read back out of the database, not the array.
  assertExcerptsVerified(persisted.findings, document.rawText, {
    path: "analyze",
    analysisId,
    documentId: document.id,
  });
  return persisted;
}

/**
 * @param {Instrumentation} record
 * @param {{ inputTokens: number, outputTokens: number, providerRequestId: string | null }} response
 */
function addUsage(record, response) {
  record.inputTokens = (record.inputTokens ?? 0) + response.inputTokens;
  record.outputTokens = (record.outputTokens ?? 0) + response.outputTokens;
  // Labelled with the REQUESTED model, the one config and the spend meter
  // use, so the series stays one per configured model rather than one per
  // dated snapshot the provider reports serving.
  const model = config.llmParamProfile.model;
  llmTokensTotal.inc({ direction: "input", model }, response.inputTokens);
  llmTokensTotal.inc({ direction: "output", model }, response.outputTokens);
  record.providerRequestId = response.providerRequestId;
}

/** Prisma's upper-case enums to the lower-case label values the dashboards use. */
const lower = (/** @type {string} */ value) => value.toLowerCase();

/**
 * §6.6's analysis metrics, for one terminal outcome. Called once per
 * analysis, on both paths, from the same places as logOutcome.
 *
 * @param {{
 *   record: Instrumentation,
 *   durationMs: number,
 *   errorCode?: string,
 *   completed?: { overallRisk: import("@prisma/client").Risk | null, modelRisk: import("@prisma/client").Risk | null, findings: { severity: import("@prisma/client").Severity }[] },
 * }} input
 */
function recordAnalysisMetrics({ record, durationMs, errorCode, completed }) {
  const outcome = completed ? "completed" : "failed";
  analysisTotal.inc({ outcome, error_code: errorCode ?? "none" });
  analysisDuration.observe({ outcome }, durationMs / 1000);
  // Counted on failure too: ALL_FINDINGS_DISCARDED is a run where every
  // finding was discarded, and leaving those out would hide the worst
  // cases from the discard rate.
  if (record.discardedFindings > 0)
    analysisFindingsDiscardedTotal.inc(record.discardedFindings);
  if (!completed) return;
  for (const finding of completed.findings) {
    analysisFindingsTotal.inc({ severity: lower(finding.severity) });
  }
  if (
    completed.overallRisk &&
    completed.modelRisk &&
    completed.overallRisk !== completed.modelRisk
  ) {
    analysisRiskDriftTotal.inc({
      rule_risk: lower(completed.overallRisk),
      model_risk: lower(completed.modelRisk),
    });
  }
}

/**
 * §6.5's analysis event. Counts and identifiers only — never document text,
 * excerpts or summaries. A failure or a discarded finding is expected but
 * notable, so it logs at warn.
 *
 * @param {{ id: string, wordCount: number }} document
 * @param {string} analysisId
 * @param {"COMPLETED" | "FAILED"} status
 * @param {string | null} errorCode
 * @param {Instrumentation} record
 * @param {number | null} durationMs
 * @param {number} findingCount
 */
function logOutcome(
  document,
  analysisId,
  status,
  errorCode,
  record,
  durationMs,
  findingCount,
) {
  const event = {
    analysis: {
      id: analysisId,
      documentId: document.id,
      wordCount: document.wordCount,
      model: config.llmParamProfile.model,
      promptVersion: PROMPT_VERSION,
      status,
      errorCode,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      durationMs,
      retryCount: record.retryCount,
      findingCount,
      discardedFindings: record.discardedFindings,
      providerRequestId: record.providerRequestId,
    },
  };
  if (status === "FAILED" || record.discardedFindings > 0) {
    logger.warn(event, "analysis finished");
  } else {
    logger.info(event, "analysis finished");
  }
}
