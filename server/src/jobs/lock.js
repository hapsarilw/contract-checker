import prisma from "../lib/prisma.js";

/**
 * SRS §12.3: "Each job takes an advisory lock so multiple instances do not
 * run it concurrently." Extracted at step 62, when the lock-taking code
 * would otherwise have existed in four places (reaper, retention,
 * quota-reset, backup-verify).
 *
 * THE LOCK IS HELD BY A TRANSACTION THAT DOES NO WORK. `fn` runs on the
 * ordinary client, OUTSIDE that transaction, so anything it commits is
 * committed on its own. That separation is the design, not an accident:
 * pg_try_advisory_xact_lock is released when its transaction ends, so the
 * lock has to live in a transaction that spans the whole run — but doing
 * a long job's work INSIDE that transaction would make it one giant
 * transaction, and retention's batching would bound nothing. If the
 * process dies mid-run, the lock connection dies with it, Postgres
 * releases the lock, and whatever `fn` already committed stays committed.
 *
 * NON-BLOCKING (`try`, not the waiting variant): an instance that loses
 * the race has no reason to queue behind the winner and then repeat its
 * work. It will be asked again at its next tick.
 *
 * `hashtext()` folds the key to the int4 Postgres widens to the bigint
 * the lock function takes, the same pattern storageQuota.js uses for its
 * per-user lock. A collision between two job keys would only make two
 * jobs occasionally skip a tick for each other, never run concurrently.
 *
 * @template T
 * @param {string} key a stable name, e.g. "quota-reset:monthly"
 * @param {() => Promise<T>} fn
 * @param {{ timeoutMs?: number }} [options] how long the lock-holding
 *   transaction may stay open. Past it Prisma rolls the transaction back
 *   and the lock is released, so it only has to outlast `fn`.
 * @returns {Promise<{ lockAcquired: false } | { lockAcquired: true, value: T }>}
 */
export async function withJobLock(key, fn, { timeoutMs = 60_000 } = {}) {
  return prisma.$transaction(
    async (lockTx) => {
      const [{ locked }] = /** @type {[{ locked: boolean }]} */ (
        await lockTx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked`
      );
      if (!locked) return { lockAcquired: false };
      return { lockAcquired: true, value: await fn() };
    },
    { timeout: timeoutMs, maxWait: 10_000 },
  );
}
