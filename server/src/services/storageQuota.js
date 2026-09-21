import config from "../config.js";
import { AppError } from "../lib/AppError.js";
import prisma from "../lib/prisma.js";

/**
 * FR-2.13 — a per-user cap of MAX_DOCS_PER_USER documents (100) OR
 * MAX_BYTES_PER_USER of stored text (50 MB), whichever comes first.
 *
 * PRD §10.2's rationale, kept here because it is the reason the numbers
 * exist: the cap bounds storage and, more importantly, bounds the BLAST
 * RADIUS of a compromised account. A stolen session can upload for as
 * long as it likes; this is what makes "as long as it likes" a known,
 * small quantity rather than the database's free space.
 *
 * THE TOTAL IS AN AGGREGATE QUERY, not a sum over fetched rows: the
 * database returns two numbers instead of up to a hundred rows, and the
 * arithmetic happens where the data lives.
 *
 * THE CHECK AND THE INSERT SHARE ONE TRANSACTION, behind a per-user
 * advisory lock. Without it two concurrent uploads at document 99 both
 * read "99", both pass, and the user holds 101 — a check-then-act race,
 * and one that opens across instances, where no in-process lock could
 * close it. It is the same reasoning as FR-3.8's partial unique index:
 * a guard against a race between instances has to live in the database.
 * A quota has no unique constraint to lean on, so the lock is the
 * database-side equivalent. pg_advisory_xact_lock is released
 * automatically at commit or rollback, so no failure path can leak it,
 * and it is keyed on the user, so one user's uploads never wait on
 * another's.
 */

/**
 * @param {{ count: number, bytes: number, incomingBytes: number }} usage
 */
function exceeds({ count, bytes, incomingBytes }) {
  return count + 1 > config.MAX_DOCS_PER_USER || bytes + incomingBytes > config.MAX_BYTES_PER_USER;
}

/** 50 MB → "50 MB". Whole megabytes; a quota message is not the place for decimals. */
const megabytes = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * FR-2.13: "a message pointing at deletion". Built from config rather
 * than hardcoded, so it cannot go on saying "100 documents" after
 * MAX_DOCS_PER_USER changes — the copy in errorCodes.js did exactly
 * that, and is now only the fallback.
 */
function quotaMessage() {
  return (
    `You've reached your storage limit (${config.MAX_DOCS_PER_USER} documents or ` +
    `${megabytes(config.MAX_BYTES_PER_USER)}). Delete an old document to make room for a new one.`
  );
}

/**
 * Creates the document if — and only if — it fits inside the user's quota.
 *
 * @param {string} userId
 * @param {Omit<import("@prisma/client").Prisma.DocumentUncheckedCreateInput, "userId">} data
 *   `byteSize` is the NORMALISED text's byte length (intake.js), which is
 *   what is actually stored and therefore what the quota is about.
 */
export async function createDocumentWithinQuota(userId, data) {
  return prisma.$transaction(async (tx) => {
    // hashtext() folds the id into the int4 the lock function takes. A
    // collision only means two users occasionally share a lock, which
    // costs a moment of waiting and never correctness.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

    const totals = await tx.document.aggregate({
      where: { userId },
      _count: { _all: true },
      _sum: { byteSize: true },
    });

    const usage = {
      count: totals._count._all,
      bytes: totals._sum.byteSize ?? 0,
      incomingBytes: data.byteSize,
    };

    if (exceeds(usage)) {
      throw new AppError("STORAGE_QUOTA_EXCEEDED", {
        message: quotaMessage(),
        details: { documents: usage.count, bytes: usage.bytes },
      });
    }

    return tx.document.create({ data: { ...data, userId } });
  });
}
