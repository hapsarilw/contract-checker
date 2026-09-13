/**
 * Explicit response whitelists, per §4.3's examples — never spread a
 * Prisma row into a response. A spread survives today and leaks the
 * first time someone adds a column: `userId`, `passwordHash`-adjacent
 * fields on other models, and specifically here `modelRisk`, which
 * FR-3.9 / PRD D7 requires is NEVER returned to the client. Two risk
 * numbers that can disagree are unexplainable in the interface, so the
 * only way to guarantee the client never sees the second one is for the
 * serializer to not know it exists.
 */

/**
 * Matches the POST /documents example in §4.3 exactly: id, filename,
 * sourceType, wordCount, createdAt. Deliberately excludes rawText,
 * textSha256, byteSize and userId — none of them appear in the
 * documented shape, and returning the document's full text in an API
 * response widens FR-2.7's confidentiality surface (browser memory,
 * devtools network tab, ...) for no stated purpose in Phase 1.
 */
export function serializeDocument(document) {
  return {
    id: document.id,
    filename: document.filename,
    sourceType: document.sourceType,
    wordCount: document.wordCount,
    createdAt: document.createdAt,
  };
}

/** HIGH first, per FR-4.2 / §2.2 step 12: "findings ordered high -> medium -> low". */
const SEVERITY_RANK = Object.freeze({ HIGH: 0, MEDIUM: 1, LOW: 2 });

/**
 * Matches the analyze-success example in §4.3: category, severity,
 * clauseExcerpt, explanation, suggestedChange. No `id` — the example
 * doesn't have one, and this whitelist exists specifically so a field
 * has to be added deliberately, with a reason, rather than appearing
 * because Prisma put it on the row.
 */
export function serializeFinding(finding) {
  return {
    category: finding.category,
    severity: finding.severity,
    clauseExcerpt: finding.clauseExcerpt,
    explanation: finding.explanation,
    suggestedChange: finding.suggestedChange,
  };
}

/**
 * Matches the analyze-success example in §4.3: id, status, overallRisk,
 * summary, findings, missingClauses, discardedFindings, createdAt.
 *
 * NEVER modelRisk (FR-3.9, PRD D7) — see the file header. Also never
 * documentId, model, inputTokens, outputTokens, durationMs, retryCount,
 * providerRequestId, errorCode or completedAt: none are in the
 * documented shape, and FR-4.2 asks for exactly one "analysis
 * timestamp", which the example gives as `createdAt`.
 *
 * Sorting is done here, explicitly by rank, rather than relied on from
 * a `orderBy: { severity: "desc" }` Prisma query. Postgres orders an
 * enum by its declaration order (LOW, MEDIUM, HIGH in this schema), so
 * `desc` happens to produce the right sequence today — but that's a
 * coincidence of how the enum was declared, not a stated guarantee, and
 * a future edit to schema.prisma's enum order would silently invert
 * every report. An explicit SEVERITY_RANK map can't be broken by
 * reordering an unrelated file.
 */
export function serializeAnalysis(analysis) {
  const findings = [...analysis.findings]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .map(serializeFinding);

  return {
    id: analysis.id,
    status: analysis.status,
    overallRisk: analysis.overallRisk,
    summary: analysis.summary,
    findings,
    missingClauses: analysis.missingClauses,
    discardedFindings: analysis.discardedFindings,
    createdAt: analysis.createdAt,
  };
}

/**
 * FR-4.1's list-row shape: filename (or "Pasted text"), word count,
 * overall risk of the latest COMPLETED analysis, finding count, created
 * date — plus `id`, which the field list doesn't name but which a
 * history list cannot function without: there is no way to link a row
 * to GET /documents/:id (or to key it in a client list) without one.
 *
 * `latestCompletedAnalysis` is deliberately a separate parameter rather
 * than read off `document.analyses[0]` here — it makes explicit, at the
 * call site, that this is the latest COMPLETED one specifically, not
 * "whatever the query happened to attach." GET /documents/:id (step 18)
 * uses the latest analysis of ANY status; this list view does not, per
 * FR-4.1's own wording, and conflating the two would misreport a
 * document's risk while an analysis is still PENDING or has FAILED.
 */
export function serializeDocumentListRow(document, latestCompletedAnalysis) {
  return {
    id: document.id,
    filename: document.filename ?? "Pasted text",
    wordCount: document.wordCount,
    overallRisk: latestCompletedAnalysis?.overallRisk ?? null,
    findingCount: latestCompletedAnalysis?._count?.findings ?? 0,
    createdAt: document.createdAt,
  };
}
