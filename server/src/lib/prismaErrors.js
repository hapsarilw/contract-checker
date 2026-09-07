import { AppError } from "./AppError.js";

/**
 * The name of the FR-3.8 partial unique index, defined in the
 * hand-written migration 20260907092547_analysis_one_pending_per_document.
 * It is not in schema.prisma — Prisma cannot express a partial unique
 * index — so this string is the only link between the migration and the
 * code that interprets its violations. Changing one without the other
 * silently turns a 409 into a 500.
 */
export const PENDING_ANALYSIS_INDEX = "analysis_one_pending_per_document";

/**
 * True when `err` is the unique-constraint violation raised by that index.
 *
 * FR-3.8 makes this index, not an application-level check, the
 * authoritative guard: with two or more instances a read-then-write check
 * is a race, and the loser silently double-spends an LLM call. That means
 * the violation is an EXPECTED control-flow outcome, not a defect — the
 * losing request is supposed to lose, and gets a clean 409.
 *
 * Identification is deliberately layered. Verified against a real
 * Postgres 15 and Prisma 7.10 driver adapter, the error carries:
 *   code: "P2002"
 *   meta.driverAdapterError.cause.constraint.index: <the index name>
 *   meta.driverAdapterError.cause.originalCode: "23505"
 *   message: "...Unique constraint failed on the constraint: `<name>`"
 *
 * The structured path is adapter-specific and deep enough to be worth
 * distrusting across upgrades, so the message is checked as a fallback.
 * Both are anchored on the index name, so neither can match a DIFFERENT
 * unique constraint by accident.
 */
export function isPendingAnalysisConflict(err) {
  if (!err || typeof err !== "object") return false;
  if (/** @type {{ code?: unknown }} */ (err).code !== "P2002") return false;

  const meta = /** @type {{ meta?: any }} */ (err).meta;
  const indexFromMeta = meta?.driverAdapterError?.cause?.constraint?.index;
  if (indexFromMeta === PENDING_ANALYSIS_INDEX) return true;

  // Prisma's pre-adapter shape put the constraint/field names here.
  const target = meta?.target;
  if (Array.isArray(target) && target.includes(PENDING_ANALYSIS_INDEX)) return true;
  if (target === PENDING_ANALYSIS_INDEX) return true;

  const message = /** @type {{ message?: unknown }} */ (err).message;
  return typeof message === "string" && message.includes(PENDING_ANALYSIS_INDEX);
}

/**
 * Maps that violation to the 409 the API contract specifies (§4.2). Any
 * other error is returned untouched, so a genuine failure is never
 * disguised as a concurrency conflict.
 */
export function mapPendingAnalysisConflict(err) {
  return isPendingAnalysisConflict(err) ? new AppError("ANALYSIS_IN_PROGRESS") : err;
}
