import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import config from "../config.js";
import logger from "../observability/logger.js";
import { readJobRun, recordJobFailure, recordJobSuccess } from "./jobRuns.js";
import { withJobLock } from "./lock.js";
import { startRecurring, stopRecurring } from "./scheduler.js";

/**
 * SRS §12.3's `backup-verify` — "weekly: confirm the most recent backup
 * exists and is the expected size," feeding Appendix C's
 * `backup_verify_failed` (severity 2, pages, runbook `database-restore`).
 *
 * WHY THIS EXISTS: a backup nobody has looked at is a hope. §5.6 says
 * backups are "verified, not assumed", and the failure it guards against
 * is the quiet one, a provider setting flipped or a job disabled months
 * ago, discovered only on the day the backup is needed. This job is the
 * cheap check that notices.
 *
 * WHAT IT CAN AND CANNOT SEE, stated plainly. It checks EVIDENCE OF A
 * BACKUP: that the newest file is there, recent, and plausibly sized. It
 * does not restore it and does not read it, so it cannot tell a valid
 * dump from a same-sized corrupt one. Only a restore drill can, which is
 * the `database-restore` runbook's job. This is the smoke alarm, not the
 * fire drill.
 *
 * THE BACKUP SOURCE IS A DIRECTORY, AND THAT IS A DECISION TO REVISIT.
 * §2.1 names three candidate managed-Postgres providers (Render, Neon,
 * Supabase), each with its own backup API, and the hosting choice has
 * not been made. Writing an adapter for a provider nobody has picked
 * would be guessing at three APIs. The source is therefore the narrow
 * interface `listBackups(): Promise<BackupInfo[]>` with one real
 * implementation, a directory of backup files (a `pg_dump` cron, a
 * provider's export mounted or synced to disk, or a self-managed
 * host). A provider adapter is one more function returning the same
 * shape and needs no change to anything below it.
 *
 * NOT CONFIGURED IS A FAILURE IN PRODUCTION, NEVER A SKIP. With no
 * BACKUP_DIR the check has nothing to look at, and "nothing to look at"
 * is precisely "no backup found". Skipping quietly would make a
 * production deployment with no backup monitoring look identical to one
 * with healthy backups. So in production the job runs anyway and fails,
 * which pages. Only in development (no production flag, no directory) is
 * it not scheduled at all, because there is nothing there to verify.
 *
 * WHAT IT LOGS: a reason code, an age in hours and a size in bytes.
 * Never a file name or a path: those can carry the database name or
 * the layout of the host.
 */

/**
 * @typedef {{ takenAt: Date, sizeBytes: number }} BackupInfo
 */

/** The reason codes. A closed set, because they are stored, logged and exported. */
export const REASONS = Object.freeze({
  NO_SOURCE: "no_source_configured",
  UNREADABLE: "source_unreadable",
  NO_BACKUPS: "no_backups",
  TOO_OLD: "too_old",
  TOO_SMALL: "too_small",
  SHRUNK: "shrunk",
});

/**
 * The newest backup must be at least this fraction of the one before it.
 * The absolute floor catches an empty file; this catches the truncated
 * dump that is still above the floor, and it needs no tuning because it
 * compares the database with its own history rather than with a number
 * someone guessed. Half is generous: a database that genuinely halves
 * overnight is itself worth a look, and it is a page for a person, not
 * an automatic action.
 */
export const MIN_RATIO_TO_PREVIOUS = 0.5;

/** Weekly, from the last SUCCESS. */
export const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** After a failed check, ask again after this long, so recovery is noticed the same day it is fixed. */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

/** How often an instance asks whether the check is due. */
export const TICK_INTERVAL_MS = 60 * 60 * 1000;

const BACKUP_VERIFY_LOCK_KEY = "backup-verify:weekly";
const HOUR_MS = 60 * 60 * 1000;

/**
 * The real backup source: a directory of files, newest first by
 * modification time. Dotfiles and subdirectories are ignored: a `.lock`
 * or a `.partial` beside a dump is not a backup.
 *
 * @param {string} dir
 * @returns {Promise<BackupInfo[]>}
 */
export async function listBackupsInDirectory(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith("."));
  const infos = await Promise.all(
    files.map(async (entry) => {
      const stats = await stat(join(dir, entry.name));
      return { takenAt: stats.mtime, sizeBytes: stats.size };
    }),
  );
  return infos.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

/**
 * The check itself, pure over a list, so every reason is tested without a
 * filesystem. Order matters and is the order of increasing subtlety:
 * something is there, it is recent, it is not empty, it did not shrink.
 *
 * @param {BackupInfo[]} backups newest first
 * @param {Date} now
 * @param {{ minBytes: number, maxAgeHours: number }} limits
 * @returns {{ ok: true, ageHours: number, sizeBytes: number } | { ok: false, reason: string }}
 */
export function assessBackups(backups, now, { minBytes, maxAgeHours }) {
  const [newest, previous] = backups;
  if (!newest) return { ok: false, reason: REASONS.NO_BACKUPS };

  const ageHours = (now.getTime() - newest.takenAt.getTime()) / HOUR_MS;
  if (ageHours > maxAgeHours) return { ok: false, reason: REASONS.TOO_OLD };

  if (newest.sizeBytes < minBytes) return { ok: false, reason: REASONS.TOO_SMALL };

  if (previous && newest.sizeBytes < previous.sizeBytes * MIN_RATIO_TO_PREVIOUS) {
    return { ok: false, reason: REASONS.SHRUNK };
  }

  return { ok: true, ageHours: Math.round(ageHours * 10) / 10, sizeBytes: newest.sizeBytes };
}

/**
 * Due when there is no success yet, or the last one is a week old, or the
 * last attempt FAILED and the retry interval has passed. A failure never
 * pushes the next check a week out: that would leave a paged operator
 * waiting a week to learn whether their fix worked.
 *
 * @param {{ lastSuccessAt: Date | null, lastFailureAt: Date | null }} run
 * @param {Date} now
 */
export function isBackupVerifyDue({ lastSuccessAt, lastFailureAt }, now) {
  const failingSinceSuccess = lastFailureAt && (!lastSuccessAt || lastFailureAt > lastSuccessAt);
  if (failingSinceSuccess) return now.getTime() - lastFailureAt.getTime() >= RETRY_AFTER_FAILURE_MS;
  if (!lastSuccessAt) return true;
  return now.getTime() - lastSuccessAt.getTime() >= INTERVAL_MS;
}

/**
 * One verification, under the advisory lock. A FAILED CHECK IS A NORMAL
 * RESULT, not an exception: it is recorded, logged at error, and read by
 * the gauge, and the function returns normally. An exception is reserved
 * for the check being unable to run at all, which the scheduler logs.
 *
 * @param {Date} [now]
 * @param {{
 *   listBackups?: () => Promise<BackupInfo[]>,
 *   shouldRun?: () => Promise<boolean>,
 *   limits?: { minBytes: number, maxAgeHours: number },
 * }} [options]
 * @returns {Promise<{ lockAcquired: boolean, ran: boolean, ok?: boolean, reason?: string }>}
 */
export async function runBackupVerify(
  now = new Date(),
  {
    listBackups = config.BACKUP_DIR ? () => listBackupsInDirectory(/** @type {string} */ (config.BACKUP_DIR)) : undefined,
    shouldRun,
    limits = { minBytes: config.BACKUP_MIN_BYTES, maxAgeHours: config.BACKUP_MAX_AGE_HOURS },
  } = {},
) {
  const outcome = await withJobLock(BACKUP_VERIFY_LOCK_KEY, async () => {
    if (shouldRun && !(await shouldRun())) return { ran: false };

    /** @type {ReturnType<typeof assessBackups>} */
    let result;
    if (!listBackups) {
      result = { ok: false, reason: REASONS.NO_SOURCE };
    } else {
      try {
        result = assessBackups(await listBackups(), now, limits);
      } catch {
        // The error object is deliberately dropped: an fs error message
        // quotes the path it failed on.
        result = { ok: false, reason: REASONS.UNREADABLE };
      }
    }

    if (result.ok) {
      await recordJobSuccess("backup-verify", now);
      logger.info(
        { job: "backup-verify", ageHours: result.ageHours, sizeBytes: result.sizeBytes },
        "backup verification passed",
      );
      return { ran: true, ok: true };
    }

    await recordJobFailure("backup-verify", now, result.reason);
    logger.error(
      { alert: "backup_verify_failed", job: "backup-verify", reason: result.reason },
      "backup verification FAILED: the most recent backup is missing or implausible",
    );
    return { ran: true, ok: false, reason: result.reason };
  });

  if (!outcome.lockAcquired) return { lockAcquired: false, ran: false };
  return { lockAcquired: true, ...outcome.value };
}

/** @param {Date} [now] */
export function backupVerifyTick(now = new Date()) {
  return runBackupVerify(now, {
    shouldRun: async () => isBackupVerifyDue(await readJobRun("backup-verify"), now),
  });
}

/**
 * Whether this process should schedule the check at all. Production
 * always does, configured or not (see the header); development does only
 * when a directory was given.
 */
export function shouldScheduleBackupVerify() {
  return config.isProduction || Boolean(config.BACKUP_DIR);
}

/**
 * @param {{ tick?: () => Promise<unknown>, intervalMs?: number }} [options]
 * @returns {NodeJS.Timeout}
 */
export function startBackupVerifyJob({ tick = () => backupVerifyTick(), intervalMs = TICK_INTERVAL_MS } = {}) {
  return startRecurring({ job: "backup-verify", tick, intervalMs });
}

/** @param {NodeJS.Timeout} handle */
export function stopBackupVerifyJob(handle) {
  stopRecurring(handle);
}
