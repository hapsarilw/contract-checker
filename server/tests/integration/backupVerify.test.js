import { mkdtemp, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "prom-client";
import prisma from "../../src/lib/prisma.js";
import {
  createBackupVerifyFailedGauge,
  createJobLastSuccessGauge,
} from "../../src/jobs/jobRuns.js";
import {
  REASONS,
  backupVerifyTick,
  listBackupsInDirectory,
  runBackupVerify,
} from "../../src/jobs/backupVerify.js";

/**
 * SRS §12.3's backup-verify, against a REAL directory of files with real
 * modification times, and a real database for the failure record.
 */

const NOW = new Date("2026-09-28T04:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const LIMITS = { minBytes: 1_000, maxAgeHours: 36 };

const dirs = [];
async function backupDir() {
  const dir = await mkdtemp(join(tmpdir(), "clausecheck-backups-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A backup file of `sizeBytes`, last modified `hoursAgo` before NOW. */
async function addBackup(dir, name, sizeBytes, hoursAgo) {
  const path = join(dir, name);
  await writeFile(path, Buffer.alloc(sizeBytes, 1));
  const at = new Date(NOW.getTime() - hoursAgo * HOUR_MS);
  await utimes(path, at, at);
}

const verify = (dir, options = {}) =>
  runBackupVerify(NOW, {
    listBackups: () => listBackupsInDirectory(dir),
    limits: LIMITS,
    ...options,
  });

const jobRow = () => prisma.jobRun.findUnique({ where: { job: "backup-verify" } });

describe("runBackupVerify — a healthy backup passes", () => {
  it("passes for a recent, plausibly sized backup, and records the success", async () => {
    const dir = await backupDir();
    await addBackup(dir, "clausecheck-2026-09-28.dump", 5_000, 3);

    const result = await verify(dir);

    expect(result).toEqual({ lockAcquired: true, ran: true, ok: true });
    const row = await jobRow();
    expect(row?.lastSuccessAt).toEqual(NOW);
    expect(row?.lastFailureAt).toBeNull();
  }, 30_000);

  it("ignores dotfiles and subdirectories: a .partial beside a dump is not a backup", async () => {
    const dir = await backupDir();
    await addBackup(dir, "good.dump", 5_000, 3);
    // Newer and tiny. If these were counted, the newest "backup" would be
    // implausibly small and the check would fail.
    await addBackup(dir, ".good.dump.partial", 10, 0.1);
    await mkdir(join(dir, "old-backups"));

    expect((await verify(dir)).ok).toBe(true);
  }, 30_000);
});

describe("runBackupVerify — fails loudly, with a specific reason", () => {
  it("fails when the directory is empty: no backup exists", async () => {
    const dir = await backupDir();

    const result = await verify(dir);

    expect(result).toEqual({
      lockAcquired: true,
      ran: true,
      ok: false,
      reason: REASONS.NO_BACKUPS,
    });
    const row = await jobRow();
    expect(row?.lastFailureAt).toEqual(NOW);
    expect(row?.lastFailureReason).toBe(REASONS.NO_BACKUPS);
    // A failure never masquerades as a success.
    expect(row?.lastSuccessAt).toBeNull();
  }, 30_000);

  it("fails when the newest backup is older than the limit: backups have stopped", async () => {
    const dir = await backupDir();
    // The failure mode this job is FOR: a perfectly good backup, from
    // three months ago, and nothing since.
    await addBackup(dir, "clausecheck-2026-06-20.dump", 5_000, 100 * 24);

    const result = await verify(dir);

    expect(result.reason).toBe(REASONS.TOO_OLD);
  }, 30_000);

  it("fails when the newest backup is implausibly small", async () => {
    const dir = await backupDir();
    await addBackup(dir, "empty.dump", 100, 2);

    expect((await verify(dir)).reason).toBe(REASONS.TOO_SMALL);
  }, 30_000);

  it("fails when the newest backup has shrunk to under half its predecessor, though still above the floor", async () => {
    const dir = await backupDir();
    await addBackup(dir, "yesterday.dump", 20_000, 26);
    await addBackup(dir, "today.dump", 4_000, 2);

    const result = await verify(dir);

    expect(result.reason).toBe(REASONS.SHRUNK);
  }, 30_000);

  it("does NOT fail for a modest, ordinary size change", async () => {
    const dir = await backupDir();
    await addBackup(dir, "yesterday.dump", 20_000, 26);
    await addBackup(dir, "today.dump", 19_000, 2);

    expect((await verify(dir)).ok).toBe(true);
  }, 30_000);

  it("fails when the directory does not exist, without leaking the path into the reason", async () => {
    const result = await verify(join(tmpdir(), "clausecheck-no-such-directory"));

    expect(result.reason).toBe(REASONS.UNREADABLE);
    const row = await jobRow();
    expect(row?.lastFailureReason).toBe(REASONS.UNREADABLE);
    expect(row?.lastFailureReason).not.toContain("clausecheck-no-such-directory");
  }, 30_000);

  it("fails when no backup source is configured at all: unconfigured is a failure, not a skip", async () => {
    const result = await runBackupVerify(NOW, { listBackups: undefined, limits: LIMITS });

    expect(result).toEqual({
      lockAcquired: true,
      ran: true,
      ok: false,
      reason: REASONS.NO_SOURCE,
    });
  }, 30_000);

  it("logs the failure at error level, with the alert name and a reason and nothing about the files", async () => {
    // The logger is silenced in tests (LOG_LEVEL=silent), so this spies on
    // the module's own logger.error instead.
    const { default: logger } = await import("../../src/observability/logger.js");
    const { vi } = await import("vitest");
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const dir = await backupDir();
    await addBackup(dir, "clausecheck-secret-name.dump", 10, 2);

    await verify(dir);

    expect(spy).toHaveBeenCalledTimes(1);
    const [fields] = spy.mock.calls[0];
    expect(fields).toMatchObject({
      alert: "backup_verify_failed",
      reason: REASONS.TOO_SMALL,
    });
    expect(JSON.stringify(fields)).not.toContain("clausecheck-secret-name");
    spy.mockRestore();
  }, 30_000);

  it("and for an unreadable directory, neither the log nor the stored reason carries the path an fs error would quote", async () => {
    const { default: logger } = await import("../../src/observability/logger.js");
    const { vi } = await import("vitest");
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const missing = join(tmpdir(), "clausecheck-path-that-must-not-leak");

    await verify(missing);

    const [fields] = spy.mock.calls[0];
    expect(fields).toMatchObject({
      alert: "backup_verify_failed",
      reason: REASONS.UNREADABLE,
    });
    expect(JSON.stringify(fields)).not.toContain("path-that-must-not-leak");
    expect((await jobRow())?.lastFailureReason).not.toContain("path-that-must-not-leak");
    spy.mockRestore();
  }, 30_000);
});

describe("backup_verify_failed — readable from any instance", () => {
  const value = async (gauge) => (await gauge.get()).values[0]?.value;

  it("reads 1 on a second instance that never ran the check, once it has failed", async () => {
    const instanceB = createBackupVerifyFailedGauge({ registers: [new Registry()] });
    expect(await value(instanceB)).toBe(0);

    await verify(await backupDir());

    expect(await value(instanceB)).toBe(1);
  }, 30_000);

  it("returns to 0 once a later check passes", async () => {
    const instanceB = createBackupVerifyFailedGauge({ registers: [new Registry()] });
    const dir = await backupDir();
    await verify(dir);
    expect(await value(instanceB)).toBe(1);

    await addBackup(dir, "fixed.dump", 5_000, 1);
    await runBackupVerify(new Date(NOW.getTime() + HOUR_MS), {
      listBackups: () => listBackupsInDirectory(dir),
      limits: LIMITS,
    });

    expect(await value(instanceB)).toBe(0);
  }, 30_000);

  it("reads 0, not 1, for a job that has simply never run: that is the staleness alert's business", async () => {
    const gauge = createBackupVerifyFailedGauge({ registers: [new Registry()] });
    expect(await value(gauge)).toBe(0);
  }, 30_000);

  it("a failed check does not touch the last-success timestamp of an earlier good one", async () => {
    const dir = await backupDir();
    await addBackup(dir, "good.dump", 5_000, 2);
    await verify(dir);

    const later = new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000);
    await runBackupVerify(later, {
      listBackups: () => listBackupsInDirectory(dir),
      limits: LIMITS,
    });

    const row = await jobRow();
    expect(row?.lastSuccessAt).toEqual(NOW);
    expect(row?.lastFailureAt).toEqual(later);
    const instanceB = createJobLastSuccessGauge({ registers: [new Registry()] });
    const series = (await instanceB.get()).values.find(
      (v) => v.labels.job === "backup-verify",
    );
    expect(series?.value).toBe(Math.floor(NOW.getTime() / 1000));
  }, 30_000);
});

describe("exclusivity and the weekly due-check", () => {
  it("two concurrent runs: exactly one holds the lock", async () => {
    const dir = await backupDir();
    await addBackup(dir, "good.dump", 5_000, 2);
    const [a, b] = await Promise.all([verify(dir), verify(dir)]);
    expect([a, b].filter((r) => r.lockAcquired)).toHaveLength(1);
  }, 30_000);

  it("a run that loses the lock records nothing", async () => {
    const dir = await backupDir();
    await addBackup(dir, "good.dump", 5_000, 2);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('backup-verify:weekly'))`;
      expect(await verify(dir)).toEqual({ lockAcquired: false, ran: false });
    });

    expect(await jobRow()).toBeNull();
  }, 30_000);

  it("a second tick within the week does nothing", async () => {
    const dir = await backupDir();
    await addBackup(dir, "good.dump", 5_000, 2);
    await runBackupVerify(NOW, {
      listBackups: () => listBackupsInDirectory(dir),
      limits: LIMITS,
    });

    const result = await backupVerifyTick(
      new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000),
    );

    expect(result).toEqual({ lockAcquired: true, ran: false });
  }, 30_000);
});
