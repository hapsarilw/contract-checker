import prisma from "../lib/prisma.js";
import { sendEmail } from "../lib/email.js";
import { subjectHash } from "../lib/audit.js";
import { assertCurrentPassword } from "./accountChanges.js";
import { serializeAccountExport } from "../lib/serializers.js";

/**
 * The two halves of PRD §12.5's user rights: ACCESS (FR-4.5, export) and
 * ERASURE (FR-4.6, deletion). They live in one file because they are one
 * pair — "show me everything you hold about me" and "now destroy it" —
 * and because reading them together is the only way to notice if one
 * knows about a table the other forgets.
 */

/**
 * FR-4.5. Everything this system holds about one user, in one JSON
 * document: account metadata, documents INCLUDING their raw text, every
 * analysis, every finding, and the user's own audit trail.
 *
 * One query with nested includes rather than four round trips, so the
 * whole export is a single consistent read — a document created between
 * two separate queries would otherwise appear with no analyses, or an
 * analysis with no parent document.
 *
 * SIZE IS BOUNDED BY FR-2.13, not by this function: 100 documents or
 * 50 MB of stored text per user, whichever comes first. That is the
 * number to hold in mind when reading the 3-per-day rate limit on the
 * route — the limit is not there to ration a user's own data, it is
 * there because an unbounded loop over a 50 MB read is a cheap way to
 * make the database do expensive work.
 *
 * @param {string} userId
 */
export async function exportAccount(userId) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      documents: {
        orderBy: { createdAt: "asc" },
        include: {
          analyses: {
            orderBy: { createdAt: "asc" },
            include: { findings: true },
          },
        },
      },
    },
  });

  // Not part of the User row and never will be — AuditEvent has no
  // relation to User on purpose (see lib/audit.js). subjectHash is what
  // reaches them, which is exactly why step 56 exported it.
  const auditEvents = await prisma.auditEvent.findMany({
    where: { subjectHash: subjectHash(userId) },
    orderBy: { createdAt: "asc" },
  });

  return serializeAccountExport(user, auditEvents);
}

/**
 * FR-4.6. Hard, cascading, synchronous deletion.
 *
 * NO TOMBSTONE, NO SHELL ROW, NO FLAG. PRD §8.1 is explicit about the
 * DELETED state — "Not a flag — the row is gone" — and D2 settles it:
 * "'deleted' must mean deleted". schema.prisma's UserState enum
 * deliberately has four values rather than five so this cannot drift.
 *
 * NOTHING IS INCREMENTED. Every other revocation path in this codebase
 * bumps tokenVersion; this one must not, and the reason is worth stating
 * because it looks like an omission: FR-1.9's check reads the user row,
 * and there is no row, so requireAuth answers UNAUTHENTICATED for every
 * outstanding cookie by absence. Incrementing a column on a row that is
 * about to stop existing would be theatre. (SRS FR-1.9 does list account
 * deletion among the things that increment tokenVersion; FR-4.6 is the
 * more specific requirement — "increment nothing" — and is the one
 * implemented here.)
 *
 * THE CASCADE IS THE DATABASE'S, NOT THIS FUNCTION'S. AuthToken,
 * Document → Analysis → Finding all carry ON DELETE CASCADE foreign keys
 * (migration 20260907091731_init). Deleting children by hand here would
 * be a second, weaker copy of that rule, and the copy is what goes stale
 * when a table is added — SRS §12.4 names exactly that failure: "never
 * hand-written SQL, which is where a forgotten child table becomes an
 * incomplete deletion."
 *
 * Returns the deleted user's email so the caller can send the
 * confirmation to an address that no longer has a row.
 *
 * @param {string} userId
 * @param {string} password
 * @returns {Promise<{ email: string }>}
 */
export async function deleteAccount(userId, password) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await assertCurrentPassword(user, password, "password");

  // FR-4.6's "in one transaction". A single DELETE with cascading foreign
  // keys is already atomic, so the transaction is not what makes the
  // cascade safe — it is what makes this explicit at the call site, and
  // what keeps a future addition here (another table, a bookkeeping
  // write) from being a second statement that can commit alone.
  await prisma.$transaction(async (tx) => {
    await tx.user.delete({ where: { id: userId } });
  });

  return { email: user.email };
}

/**
 * Sent after the transaction commits, never before — an email telling
 * someone their account is gone, for a deletion that then rolled back, is
 * worse than no email. Queued like every other send (NFR-3.8), so a mail
 * outage cannot turn a completed deletion into a 500.
 *
 * @param {string} email
 */
export function sendAccountDeletedNotice(email) {
  sendEmail("account_deleted", email);
}
