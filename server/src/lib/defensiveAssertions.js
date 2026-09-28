import { crossUserAccessTotal, unverifiedExcerptDisplayedTotal } from "../observability/metrics.js";
import logger from "../observability/logger.js";
import { normalizeForMatch, verifyFindings } from "../services/verify.js";
import { AppError } from "./AppError.js";

/**
 * Appendix C's two Sev-1 alerts, as assertions at the points where the
 * things they alert on would become visible to a user (BUILD-PLAN step 68).
 *
 * WHY THESE EXIST WHEN THE PIPELINE ALREADY PREVENTS BOTH. That is the
 * argument for them, not against: both conditions are impossible through
 * the code as written, which is exactly why nobody would notice a change
 * that made one possible. A WHERE clause loses its `userId`; a migration
 * copies findings between analyses; a later feature writes a Finding row
 * without going through services/analysis.js. Each of those is a plausible
 * mistake, and each produces the one outcome PRD §11.1 calls structurally
 * impossible. These assertions are what makes "structurally" true at
 * runtime rather than on inspection.
 *
 * BOTH FAIL CLOSED. Nothing is served when either fires: the request gets
 * a 500 (INTERNAL, whose body carries a requestId and nothing else), the
 * counter increments for the alert, and the operator gets a Sev-1 page.
 * Serving the data and merely counting it would be the wrong trade in both
 * cases — a fabricated excerpt shown to a user is the failure the whole
 * product rests on not happening, and another user's contract is a breach.
 *
 * NEITHER LOGS THE CONTENT. §6.5 bars document text from logs, and these
 * lines are exactly the ones a tired operator would paste into a chat
 * window. Counts and identifiers only.
 */

/**
 * FR-1.5: the document served belongs to the session's subject.
 *
 * lib/ownership.js already filters by `userId` in the query, so this can
 * only fire if that filter has been lost or bypassed. It is a cheap
 * comparison of two ids on a row already in memory.
 *
 * @template {{ id: string, userId: string }} D
 * @param {D} document
 * @param {string} userId the authenticated subject
 * @returns {D}
 */
export function assertOwnDocument(document, userId) {
  if (document.userId === userId) return document;

  crossUserAccessTotal.inc();
  // Ids, never email addresses: an alert payload travels further than a
  // log line does.
  logger.error(
    {
      alert: "cross_user_access",
      severity: 1,
      document: { id: document.id, ownerId: document.userId },
      subjectId: userId,
    },
    "SEV-1: a document was loaded for a subject that does not own it — refusing to serve it",
  );
  throw new AppError("INTERNAL");
}

/**
 * PRD §11.1: every excerpt displayed to a user passed verification.
 *
 * Re-checks each finding's excerpt against the document's own text with
 * §5.3's matcher, the same one that admitted it, at the moment it is about
 * to be serialized. What this catches is a finding row that never went
 * through that check, not a bug in the check itself — re-running a broken
 * matcher would agree with itself. That is the realistic failure: the
 * matcher is one small module with 100% branch coverage and a lint rule
 * against it gaining a dependency (§5.3), while the paths that could write
 * a Finding row are many and will grow.
 *
 * Cost: one normalisation of the document text per response that carries
 * findings, on documents capped at 4,000 words (FR-2.4). Both the analyze
 * response and the report read are covered, because "every excerpt
 * displayed" has no exception for the one that was just verified.
 *
 * @template {{ clauseExcerpt: string }} F
 * @param {readonly F[]} findings
 * @param {string} rawText the document's stored text
 * @param {{ path: string, analysisId: string, documentId: string }} context
 *   `path` is a coarse label ("analyze" or "report"), never a URL: it is a
 *   metric label, so it must come from a closed set.
 * @returns {readonly F[]}
 */
export function assertExcerptsVerified(findings, rawText, context) {
  if (findings.length === 0) return findings;

  // verifyFindings takes §5.2's snake_case shape; these rows are Prisma's.
  const { discardedCount } = verifyFindings(
    findings.map((finding) => ({ clause_excerpt: finding.clauseExcerpt })),
    normalizeForMatch(rawText),
  );
  if (discardedCount === 0) return findings;

  unverifiedExcerptDisplayedTotal.inc({ path: context.path }, discardedCount);
  // The count, never the excerpt: the whole point is that this text is not
  // in the document, and a log line is not the place to publish it.
  logger.error(
    {
      alert: "unverified_excerpt_displayed",
      severity: 1,
      path: context.path,
      analysis: { id: context.analysisId, documentId: context.documentId },
      unverified: discardedCount,
      findings: findings.length,
    },
    "SEV-1: a stored finding's excerpt is not in its document — refusing to serve the report",
  );
  throw new AppError("INTERNAL");
}
