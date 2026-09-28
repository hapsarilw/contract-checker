import { AppError } from "../lib/AppError.js";
import pg from "pg";
import { AUDIT_ACTIONS, recordAuditEvent, subjectHash } from "../lib/audit.js";
import prisma from "../lib/prisma.js";
import logger from "../observability/logger.js";
import { eraseAccount, exportAccount, sendAccountDeletedNotice } from "./account.js";
import { periodOf, periodStartOf } from "./quota.js";
import { usdFor } from "./spend.js";

/**
 * The operator actions the runbooks in docs/runbooks/ call for
 * (BUILD-PLAN step 69), and nothing else. Run through scripts/ops.js from a
 * shell on the platform, never over HTTP: there is no admin API, on
 * purpose. An admin endpoint is a permanent attack surface for actions an
 * operator needs a few times a year; a script run from the platform's own
 * shell needs the platform's own credentials to reach at all.
 *
 * EVERY MUTATING ACTION TAKES A REFERENCE — the ticket, email thread or
 * incident id that justifies it — and writes an audit event. An operator
 * suspending or deleting an account with no recorded reason is the event a
 * later investigation most needs to explain and can least.
 *
 * NONE OF THESE WRITE SQL BY HAND. Suspension is one field on one row;
 * export and erasure are services/account.js's own functions, the ones the
 * self-serve routes use, because SRS §12.4 names the failure a second copy
 * invites: "a forgotten child table becomes an incomplete deletion."
 */

/**
 * Finds the account an operator was given an address for. Normalised the
 * way registration normalises it (schemas/auth.js), so the address from an
 * email header finds the account whatever its case.
 *
 * @param {string} email
 */
export async function findAccountByEmail(email) {
  const normalised = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalised } });
  if (!user)
    throw new AppError("NOT_FOUND", {
      message: `No account with the address ${normalised}.`,
    });
  return user;
}

/** @param {string | undefined} reference */
function requireReference(reference) {
  if (!reference || reference.trim().length < 3) {
    throw new AppError("VALIDATION_ERROR", {
      message:
        "A --reference (the ticket, thread or incident this action is for) is required.",
    });
  }
  return reference.trim();
}

/**
 * Suspends an account. Takes effect on the account's NEXT request: the
 * session cookie still verifies, but requireAuth answers 403
 * ACCOUNT_SUSPENDED to every authenticated call while the state holds, so
 * no token needs revoking.
 *
 * @param {string} email
 * @param {{ reference?: string }} options
 */
export async function suspendAccount(email, { reference }) {
  const ref = requireReference(reference);
  const user = await findAccountByEmail(email);
  if (user.state === "SUSPENDED")
    return { id: user.id, state: user.state, changed: false };

  await prisma.user.update({ where: { id: user.id }, data: { state: "SUSPENDED" } });
  await recordAuditEvent(AUDIT_ACTIONS.OPERATOR_SUSPENDED, {
    userId: user.id,
    requestId: `operator:${ref}`,
  });
  logger.warn(
    { operator: { action: "suspend", userId: user.id, reference: ref } },
    "operator suspended an account",
  );
  return { id: user.id, state: "SUSPENDED", changed: true };
}

/**
 * Lifts a suspension, back to whichever state the account had EARNED: ACTIVE
 * if its address was ever verified, UNVERIFIED if not. Restoring ACTIVE
 * unconditionally would let a suspension-and-lift skip email verification,
 * which FR-1.7 makes the gate on the one expensive action.
 *
 * @param {string} email
 * @param {{ reference?: string }} options
 */
export async function liftSuspension(email, { reference }) {
  const ref = requireReference(reference);
  const user = await findAccountByEmail(email);
  if (user.state !== "SUSPENDED")
    return { id: user.id, state: user.state, changed: false };

  const state = user.emailVerifiedAt ? "ACTIVE" : "UNVERIFIED";
  await prisma.user.update({ where: { id: user.id }, data: { state } });
  await recordAuditEvent(AUDIT_ACTIONS.OPERATOR_SUSPENSION_LIFTED, {
    userId: user.id,
    requestId: `operator:${ref}`,
  });
  logger.warn(
    { operator: { action: "lift-suspension", userId: user.id, reference: ref } },
    "operator lifted a suspension",
  );
  return { id: user.id, state, changed: true };
}

/**
 * The spend runbook's question: is one account responsible? This month's
 * provider tokens per account, most expensive first, from the Analysis rows
 * that record them (FR-3.5) — failed analyses included, because they spent
 * tokens too (FR-5.2).
 *
 * WHAT IT CANNOT SEE: tokens spent by an account since deleted (the rows
 * went with it) — the monthly spend meter still counts those, so the total
 * here can be lower than llm_spend_usd_month, and the runbook says what
 * the gap means.
 *
 * @param {{ now?: Date, limit?: number }} [options]
 */
export async function spendByAccount({ now = new Date(), limit = 10 } = {}) {
  const analyses = await prisma.analysis.findMany({
    where: { createdAt: { gte: periodStartOf(now) } },
    select: {
      inputTokens: true,
      outputTokens: true,
      status: true,
      document: { select: { userId: true } },
    },
  });

  /** @type {Map<string, { analyses: number, failed: number, inputTokens: number, outputTokens: number }>} */
  const byUser = new Map();
  for (const analysis of analyses) {
    const userId = analysis.document.userId;
    const row = byUser.get(userId) ?? {
      analyses: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    row.analyses += 1;
    if (analysis.status === "FAILED") row.failed += 1;
    row.inputTokens += analysis.inputTokens ?? 0;
    row.outputTokens += analysis.outputTokens ?? 0;
    byUser.set(userId, row);
  }

  const totalUsd = [...byUser.values()].reduce(
    (sum, r) => sum + usdFor(r.inputTokens, r.outputTokens),
    0,
  );
  const ranked = [...byUser.entries()]
    .map(([userId, row]) => ({
      userId,
      ...row,
      usd: usdFor(row.inputTokens, row.outputTokens),
    }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, limit);

  const users = await prisma.user.findMany({
    where: { id: { in: ranked.map((r) => r.userId) } },
    select: { id: true, email: true, state: true, createdAt: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  return {
    period: periodOf(now),
    accounts: byUser.size,
    totalUsd,
    top: ranked.map((row) => ({
      ...row,
      email: byId.get(row.userId)?.email ?? null,
      state: byId.get(row.userId)?.state ?? null,
      accountCreatedAt: byId.get(row.userId)?.createdAt ?? null,
      shareOfTotal: totalUsd === 0 ? 0 : row.usd / totalUsd,
    })),
  };
}

/**
 * SRS §12.4 step 2, for a user who cannot use the self-serve export: the
 * same export (services/account.js), recorded as OPERATOR_EXPORTED.
 *
 * @param {string} email
 * @param {{ reference?: string }} options
 */
export async function operatorExport(email, { reference }) {
  const ref = requireReference(reference);
  const user = await findAccountByEmail(email);
  const data = await exportAccount(user.id);
  await recordAuditEvent(AUDIT_ACTIONS.OPERATOR_EXPORTED, {
    userId: user.id,
    requestId: `dsar:${ref}`,
  });
  logger.warn(
    { operator: { action: "export", userId: user.id, reference: ref } },
    "operator exported an account's data",
  );
  return data;
}

/**
 * SRS §12.4 step 3, operator-side: the SAME erasure self-serve deletion
 * uses (eraseAccount), then the same audit event and the same confirmation
 * email. Identity must already have been verified out of band — that is
 * step 1 of the runbook, and nothing here can check it.
 *
 * The audit row is written after the delete, as the route does it: there is
 * no user row to relate it to either way (AuditEvent has no foreign key to
 * User, lib/audit.js), and writing it first would record a deletion that
 * then might not happen.
 *
 * @param {string} email
 * @param {{ reference?: string, confirm?: string }} options `confirm` must
 *   repeat the address: the one guard against a pasted wrong line.
 */
export async function operatorErase(email, { reference, confirm }) {
  const ref = requireReference(reference);
  if (!confirm || confirm.trim().toLowerCase() !== email.trim().toLowerCase()) {
    throw new AppError("VALIDATION_ERROR", {
      message:
        "--confirm must repeat the account's address exactly. Nothing was deleted.",
    });
  }
  const user = await findAccountByEmail(email);
  const { email: deletedEmail } = await eraseAccount(user);
  await recordAuditEvent(AUDIT_ACTIONS.ACCOUNT_DELETED, {
    userId: user.id,
    requestId: `dsar:${ref}`,
  });
  sendAccountDeletedNotice(deletedEmail);
  logger.warn(
    { operator: { action: "erase", userId: user.id, reference: ref } },
    "operator erased an account",
  );
  return { id: user.id, deleted: true };
}

/**
 * After a database restore: which accounts in the RESTORED database were
 * deleted after the backup was taken, and so have just come back to life?
 * (docs/runbooks/database-restore.md.)
 *
 * WHY THIS NEEDS A TOOL. A deletion leaves no identifying trace by design:
 * the account row is gone, the audit trail holds only hmac(userId,
 * AUDIT_SALT) (lib/audit.js), and no log line names the user. The
 * ACCOUNT_DELETED events recorded since the backup are in the OLD database —
 * the one being replaced — and not in the restore. So this reads those
 * events from the old database, hashes every account in the restored one
 * with the same salt, and lists the matches for the operator to erase again.
 * Found missing by the step-69 walkthrough, which is what walkthroughs are
 * for: without it, "re-run the deletions" was an instruction nobody could
 * follow, and a restore quietly resurrected contracts users had deleted.
 *
 * It lists; it does not erase. Each erasure is run deliberately, through
 * operatorErase, with its own reference.
 *
 * Needs the SAME AUDIT_SALT the old database's events were written with —
 * one more reason secret-rotation.md keeps that salt out of any "rotate
 * everything" response.
 *
 * @param {{ oldDatabaseUrl: string, since: Date }} options
 */
export async function restoredDeletions({ oldDatabaseUrl, since }) {
  if (Number.isNaN(since.getTime())) {
    throw new AppError("VALIDATION_ERROR", {
      message: "--since must be a date, e.g. 2026-09-28T03:00:00Z.",
    });
  }
  const old = new pg.Client({ connectionString: oldDatabaseUrl });
  await old.connect();
  /** @type {Set<string>} */
  let deleted;
  try {
    // The instant goes over as an ISO string and is converted to UTC in SQL.
    // Prisma stores DateTime as `timestamp` WITHOUT a time zone, in UTC; a
    // JS Date handed to node-pg is serialised in the PROCESS's local zone,
    // and Postgres drops the offset when comparing it with a zoneless
    // column. On a machine at UTC+8 that moved "since" eight hours into the
    // future and this reported no deletions at all — found by the restore
    // walkthrough, and invisible on a UTC server, which is why the test for
    // it runs in a non-UTC zone.
    const { rows } = await old.query(
      'select "subjectHash" from "AuditEvent" where action = $1 and "createdAt" > ($2::timestamptz at time zone \'UTC\')',
      [AUDIT_ACTIONS.ACCOUNT_DELETED, since.toISOString()],
    );
    deleted = new Set(rows.map((row) => row.subjectHash));
  } finally {
    await old.end();
  }
  if (deleted.size === 0) return { deletedSince: 0, resurrected: [] };

  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  return {
    deletedSince: deleted.size,
    resurrected: users.filter((user) => deleted.has(subjectHash(user.id))),
  };
}
