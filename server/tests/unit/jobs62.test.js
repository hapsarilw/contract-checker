import { describe, it, expect, vi, afterEach } from "vitest";
import {
  INTERVAL_MS,
  MIN_RATIO_TO_PREVIOUS,
  REASONS,
  RETRY_AFTER_FAILURE_MS,
  TICK_INTERVAL_MS as BACKUP_TICK_MS,
  assessBackups,
  isBackupVerifyDue,
  startBackupVerifyJob,
  stopBackupVerifyJob,
} from "../../src/jobs/backupVerify.js";
import { TICK_INTERVAL_MS as QUOTA_TICK_MS, isQuotaResetDue, startQuotaResetJob, stopQuotaResetJob } from "../../src/jobs/quotaReset.js";
import { isFailing } from "../../src/jobs/jobRuns.js";

/**
 * The pure halves of step 62's two jobs. The reset and the file checks
 * themselves run against a real Postgres and a real directory in
 * tests/integration/quotaReset.test.js and backupVerify.test.js.
 */

const HOUR_MS = 60 * 60 * 1000;
const at = (iso) => new Date(iso);
const LIMITS = { minBytes: 1_000, maxAgeHours: 36 };
const NOW = at("2026-09-28T04:00:00Z");
const backup = (sizeBytes, hoursAgo) => ({ sizeBytes, takenAt: new Date(NOW.getTime() - hoursAgo * HOUR_MS) });

describe("isQuotaResetDue — due until this period has a successful reset", () => {
  it("is due when the job has never succeeded", () => {
    expect(isQuotaResetDue(null, at("2026-07-15T12:00:00Z"))).toBe(true);
  });

  it("is due on the first tick of a new month", () => {
    expect(isQuotaResetDue(at("2026-06-01T00:10:00Z"), at("2026-07-01T00:05:00Z"))).toBe(true);
  });

  it("stays due, being retried, until one succeeds, not just at midnight on the 1st", () => {
    // Three days into the month with no reset yet: an outage covered the
    // first. A fixed-instant trigger would have skipped the month.
    expect(isQuotaResetDue(at("2026-06-01T00:10:00Z"), at("2026-07-04T09:00:00Z"))).toBe(true);
  });

  it("is not due again within the same month", () => {
    expect(isQuotaResetDue(at("2026-07-01T00:10:00Z"), at("2026-07-31T23:59:00Z"))).toBe(false);
  });

  it("uses UTC months, matching the metering's own period", () => {
    // 23:30 on 30 June UTC is still June, whatever a local clock says.
    expect(isQuotaResetDue(at("2026-06-01T00:10:00Z"), at("2026-06-30T23:30:00Z"))).toBe(false);
    expect(isQuotaResetDue(at("2026-06-01T00:10:00Z"), at("2026-07-01T00:00:00Z"))).toBe(true);
  });
});

describe("assessBackups — every failure reason, and only those", () => {
  it("fails with no_backups when there is nothing", () => {
    expect(assessBackups([], NOW, LIMITS)).toEqual({ ok: false, reason: REASONS.NO_BACKUPS });
  });

  it("passes a recent, plausibly sized backup", () => {
    expect(assessBackups([backup(5_000, 3)], NOW, LIMITS)).toEqual({ ok: true, ageHours: 3, sizeBytes: 5_000 });
  });

  it("the age limit is inclusive: exactly maxAgeHours old still passes, a moment past it does not", () => {
    expect(assessBackups([backup(5_000, 36)], NOW, LIMITS).ok).toBe(true);
    expect(assessBackups([backup(5_000, 36.01)], NOW, LIMITS)).toEqual({ ok: false, reason: REASONS.TOO_OLD });
  });

  it("the size floor is inclusive: exactly minBytes passes, one byte under does not", () => {
    expect(assessBackups([backup(1_000, 3)], NOW, LIMITS).ok).toBe(true);
    expect(assessBackups([backup(999, 3)], NOW, LIMITS)).toEqual({ ok: false, reason: REASONS.TOO_SMALL });
  });

  it("the shrink ratio is inclusive: exactly half the previous passes, just under does not", () => {
    expect(MIN_RATIO_TO_PREVIOUS).toBe(0.5);
    expect(assessBackups([backup(10_000, 2), backup(20_000, 26)], NOW, LIMITS).ok).toBe(true);
    expect(assessBackups([backup(9_999, 2), backup(20_000, 26)], NOW, LIMITS)).toEqual({ ok: false, reason: REASONS.SHRUNK });
  });

  it("with only one backup there is no previous to compare against, and it is judged on the floor alone", () => {
    expect(assessBackups([backup(1_500, 2)], NOW, LIMITS).ok).toBe(true);
  });

  it("checks age before size: an old, tiny backup is reported as old", () => {
    expect(assessBackups([backup(10, 500)], NOW, LIMITS)).toEqual({ ok: false, reason: REASONS.TOO_OLD });
  });

  it("only the newest is judged on age: an old previous backup does not fail a fresh one", () => {
    expect(assessBackups([backup(5_000, 2), backup(5_000, 900)], NOW, LIMITS).ok).toBe(true);
  });
});

describe("isBackupVerifyDue — weekly, but a failure is retried within the hour", () => {
  it("is due when it has never run", () => {
    expect(isBackupVerifyDue({ lastSuccessAt: null, lastFailureAt: null }, NOW)).toBe(true);
  });

  it("is not due within a week of the last success", () => {
    const ok = new Date(NOW.getTime() - INTERVAL_MS + 1);
    expect(isBackupVerifyDue({ lastSuccessAt: ok, lastFailureAt: null }, NOW)).toBe(false);
  });

  it("is due exactly a week after the last success", () => {
    const ok = new Date(NOW.getTime() - INTERVAL_MS);
    expect(isBackupVerifyDue({ lastSuccessAt: ok, lastFailureAt: null }, NOW)).toBe(true);
  });

  it("after a failure, waits the retry interval and no longer: recovery is noticed the same day it is fixed", () => {
    const success = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    const justFailed = new Date(NOW.getTime() - RETRY_AFTER_FAILURE_MS + 1);
    const failedAnHourAgo = new Date(NOW.getTime() - RETRY_AFTER_FAILURE_MS);
    expect(isBackupVerifyDue({ lastSuccessAt: success, lastFailureAt: justFailed }, NOW)).toBe(false);
    expect(isBackupVerifyDue({ lastSuccessAt: success, lastFailureAt: failedAnHourAgo }, NOW)).toBe(true);
  });

  it("a failure older than the last success no longer counts as failing", () => {
    const failure = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
    const success = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);
    expect(isBackupVerifyDue({ lastSuccessAt: success, lastFailureAt: failure }, NOW)).toBe(false);
  });

  it("a job that has only ever failed is retried on the interval, not immediately", () => {
    const failure = new Date(NOW.getTime() - 10 * 60 * 1000);
    expect(isBackupVerifyDue({ lastSuccessAt: null, lastFailureAt: failure }, NOW)).toBe(false);
  });
});

describe("isFailing — a failure newer than the last success", () => {
  it("is false with no failure", () => {
    expect(isFailing({ lastSuccessAt: NOW, lastFailureAt: null })).toBe(false);
  });
  it("is true for a failure and no success at all", () => {
    expect(isFailing({ lastSuccessAt: null, lastFailureAt: NOW })).toBe(true);
  });
  it("is true when the failure is newer than the success", () => {
    expect(isFailing({ lastSuccessAt: at("2026-09-20T00:00:00Z"), lastFailureAt: NOW })).toBe(true);
  });
  it("is false when the success is newer than the failure", () => {
    expect(isFailing({ lastSuccessAt: NOW, lastFailureAt: at("2026-09-20T00:00:00Z") })).toBe(false);
  });
  it("is false for a job that has never run", () => {
    expect(isFailing({ lastSuccessAt: null, lastFailureAt: null })).toBe(false);
  });
});

describe("the two schedulers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("quota-reset asks once immediately and then hourly, until stopped", async () => {
    vi.useFakeTimers();
    const tick = vi.fn().mockResolvedValue({});
    const handle = startQuotaResetJob({ tick });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(QUOTA_TICK_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    stopQuotaResetJob(handle);
    await vi.advanceTimersByTimeAsync(QUOTA_TICK_MS * 3);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("backup-verify asks once immediately and then hourly, until stopped", async () => {
    vi.useFakeTimers();
    const tick = vi.fn().mockResolvedValue({});
    const handle = startBackupVerifyJob({ tick });
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BACKUP_TICK_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    stopBackupVerifyJob(handle);
    await vi.advanceTimersByTimeAsync(BACKUP_TICK_MS * 3);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
