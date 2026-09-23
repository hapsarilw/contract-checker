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

/** One comparator, so the report and the export cannot order differently. */
const bySeverity = (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];

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
  const findings = [...analysis.findings].sort(bySeverity).map(serializeFinding);

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

/**
 * FR-4.5's export — a DIFFERENT whitelist from the report one above, and
 * the difference is the point: this is the only serializer in the system
 * that returns `rawText`. Everywhere else FR-2.7 keeps a document's text
 * off the wire; here the user is asking for their own text back, which is
 * what "portability" means in PRD §12.5.
 *
 * `modelRisk` IS STILL EXCLUDED. PRD D7 is not a rule about the report
 * screen, it is a rule about the field: two risk numbers that can
 * disagree are unexplainable wherever they appear, and an export is a
 * file people forward to other people with no interface around it to
 * explain the discrepancy. Exclusion is by whitelist rather than by
 * delete, so the field cannot come back by someone adding a spread.
 *
 * @param {any} analysis
 */
export function serializeExportAnalysis(analysis) {
  return {
    id: analysis.id,
    status: analysis.status,
    overallRisk: analysis.overallRisk,
    summary: analysis.summary,
    missingClauses: analysis.missingClauses,
    discardedFindings: analysis.discardedFindings,
    errorCode: analysis.errorCode,
    // Which model, and which revision of the prompt, produced this
    // report. Handing someone an analysis without saying what produced it
    // makes the export less useful than the screen it came from.
    model: analysis.model,
    promptVersion: analysis.promptVersion,
    createdAt: analysis.createdAt,
    completedAt: analysis.completedAt,
    findings: [...analysis.findings].sort(bySeverity).map(serializeFinding),
  };
}

/**
 * Deliberately absent from the analysis above: `documentId` (the nesting
 * already says it), and the operational telemetry — inputTokens,
 * outputTokens, durationMs, retryCount, providerRequestId. Those describe
 * a request this system made to a provider, not a fact about the person
 * asking; an access request is for data about them.
 *
 * @param {any} document
 */
export function serializeExportDocument(document) {
  return {
    id: document.id,
    filename: document.filename,
    sourceType: document.sourceType,
    rawText: document.rawText,
    wordCount: document.wordCount,
    byteSize: document.byteSize,
    createdAt: document.createdAt,
    analyses: document.analyses.map(serializeExportAnalysis),
  };
}

/**
 * The whole export. `user` is a User row with documents → analyses →
 * findings included; `auditEvents` are the rows whose subjectHash matches
 * this user, fetched separately because AuditEvent has no relation to
 * User and must never gain one (lib/audit.js).
 *
 * NEVER passwordHash — a credential is not personal data to hand back,
 * and it is the one field on this row that a leaked export would make
 * catastrophic. Also excluded: tokenVersion, failedLoginCount,
 * firstFailedLoginAt and lockedUntil, which are the internal state of
 * mechanisms (FR-1.9, FR-1.10) rather than anything the person could read
 * as a fact about themselves.
 *
 * The audit rows are reduced to what they MEAN — an action and a time.
 * `subjectHash` and `ipHash` are HMAC outputs, internal correlation keys
 * with no use to their subject, and `requestId` correlates a server log
 * line the user cannot read.
 *
 * @param {any} user
 * @param {Array<{ action: string, createdAt: Date }>} auditEvents
 */
export function serializeAccountExport(user, auditEvents) {
  return {
    // The export is a snapshot, and a file with no date on it is one
    // whose staleness cannot be judged later.
    exportedAt: new Date(),
    account: {
      id: user.id,
      email: user.email,
      state: user.state,
      emailVerifiedAt: user.emailVerifiedAt,
      pendingEmail: user.pendingEmail,
      monthlyAnalyses: user.monthlyAnalyses,
      quotaPeriodStart: user.quotaPeriodStart,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    documents: user.documents.map(serializeExportDocument),
    securityEvents: auditEvents.map((event) => ({
      action: event.action,
      at: event.createdAt,
    })),
  };
}
