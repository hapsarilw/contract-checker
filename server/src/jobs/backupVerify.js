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
 * THE BACKUP SOURCE: A DIRECTORY, OR (STEP 75) AN S3 BUCKET. Revisited on
 * 2026-10-12, when the hosting choice (Render) showed the gap the text below
 * anticipated: a managed provider's backups are not files the API can see.
 * The owner chose a nightly encrypted pg_dump to S3 (ops/backup), destroyed within 30
 * days, and listBackupsInS3 below reads it. The original reasoning:
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

/** What ops/backup/backup.sh names every dump: encrypted with age. */
export const S3_BACKUP_SUFFIX = ".dump.age";

/**
 * @typedef {{ Bucket: string, Prefix: string, ContinuationToken?: string }} ListInput
 * @typedef {{
 *   Contents?: { Key?: string, LastModified?: Date | string, Size?: number }[],
 *   IsTruncated?: boolean,
 *   NextContinuationToken?: string,
 * }} ListPage
 */

/**
 * ListObjectsV2 against the configured bucket, with the AWS SDK loaded
 * only when a bucket is configured: it is a large module, and a process
 * that never lists a bucket should not carry it.
 *
 * @param {{ region?: string, endpoint?: string, accessKeyId?: string, secretAccessKey?: string }} [options]
 *   the configured bucket's, unless a test points it elsewhere
 * @returns {(input: ListInput) => Promise<ListPage>}
 */
export function s3Lister({
  region = config.BACKUP_S3_REGION,
  endpoint = config.BACKUP_S3_ENDPOINT,
  accessKeyId = config.BACKUP_S3_ACCESS_KEY_ID,
  secretAccessKey = config.BACKUP_S3_SECRET_ACCESS_KEY,
} = {}) {
  /** @type {Promise<(input: ListInput) => Promise<ListPage>> | undefined} */
  let ready;
  return async (input) => {
    ready ??= import("@aws-sdk/client-s3").then(({ S3Client, ListObjectsV2Command }) => {
      const client = new S3Client({
        region,
        ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
        credentials: {
          accessKeyId: /** @type {string} */ (accessKeyId),
          secretAccessKey: /** @type {string} */ (secretAccessKey),
        },
        // NFR-3.7: a bounded wait, like every other outbound call.
        requestHandler: { requestTimeout: 15_000, connectionTimeout: 5_000 },
      });
      return (/** @type {ListInput} */ listInput) =>
        /** @type {Promise<ListPage>} */ (
          client.send(new ListObjectsV2Command(listInput))
        );
    });
    return (await ready)(input);
  };
}

/**
 * The second real source (step 75): the bucket ops/backup's nightly job
 * writes to, newest first. Only objects named like its dumps count, so a
 * stray upload or a half-written multipart part is not taken for a backup.
 * Upload time stands for the time the dump was taken: the job uploads as
 * soon as the dump is encrypted.
 *
 * @param {{ bucket: string, prefix?: string, list?: (input: ListInput) => Promise<ListPage> }} options
 * @returns {Promise<BackupInfo[]>}
 */
export async function listBackupsInS3({ bucket, prefix = "", list = s3Lister() }) {
  /** @type {BackupInfo[]} */
  const backups = [];
  /** @type {string | undefined} */
  let token;
  do {
    const page = await list({
      Bucket: bucket,
      Prefix: prefix,
      ...(token ? { ContinuationToken: token } : {}),
    });
    for (const object of page.Contents ?? []) {
      if (
        typeof object.Key === "string" &&
        object.Key.endsWith(S3_BACKUP_SUFFIX) &&
        object.LastModified &&
        typeof object.Size === "number"
      ) {
        backups.push({ takenAt: new Date(object.LastModified), sizeBytes: object.Size });
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return backups.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

/** The configured source, or undefined when there is none (a failure in production). */
function configuredSource() {
  if (config.BACKUP_DIR) {
    const dir = config.BACKUP_DIR;
    return () => listBackupsInDirectory(dir);
  }
  if (config.BACKUP_S3_BUCKET) {
    const bucket = config.BACKUP_S3_BUCKET;
    const list = s3Lister();
    return () => listBackupsInS3({ bucket, prefix: config.BACKUP_S3_PREFIX, list });
  }
  return undefined;
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

  return {
    ok: true,
    ageHours: Math.round(ageHours * 10) / 10,
    sizeBytes: newest.sizeBytes,
  };
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
  const failingSinceSuccess =
    lastFailureAt && (!lastSuccessAt || lastFailureAt > lastSuccessAt);
  if (failingSinceSuccess)
    return now.getTime() - lastFailureAt.getTime() >= RETRY_AFTER_FAILURE_MS;
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
    listBackups = configuredSource(),
    shouldRun,
    limits = {
      minBytes: config.BACKUP_MIN_BYTES,
      maxAgeHours: config.BACKUP_MAX_AGE_HOURS,
    },
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
        // quotes the path it failed on, and an S3 one the bucket.
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
 * when a source (a directory or a bucket) was given.
 */
export function shouldScheduleBackupVerify() {
  return config.isProduction || Boolean(config.BACKUP_DIR || config.BACKUP_S3_BUCKET);
}

/**
 * @param {{ tick?: () => Promise<unknown>, intervalMs?: number }} [options]
 * @returns {NodeJS.Timeout}
 */
export function startBackupVerifyJob({
  tick = () => backupVerifyTick(),
  intervalMs = TICK_INTERVAL_MS,
} = {}) {
  return startRecurring({ job: "backup-verify", tick, intervalMs });
}

/** @param {NodeJS.Timeout} handle */
export function stopBackupVerifyJob(handle) {
  stopRecurring(handle);
}
