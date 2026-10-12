import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/config.js";
import {
  S3_BACKUP_SUFFIX,
  assessBackups,
  listBackupsInS3,
} from "../../src/jobs/backupVerify.js";

/**
 * Step 75: the S3 backup source (the owner's decision of 2026-10-12: S3,
 * 30 days, age). The listing is tested here against a fake of
 * ListObjectsV2; ops/backup/drill.sh runs the same function against MinIO
 * with the policy the API's key will have in AWS.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-12T12:00:00Z");

/** @param {{ Key?: string, LastModified?: Date | string, Size?: number }[][]} pages */
function fakeBucket(pages) {
  return vi.fn(async (/** @type {{ ContinuationToken?: string }} */ input) => {
    const index = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
    const more = index + 1 < pages.length;
    return {
      Contents: pages[index],
      IsTruncated: more,
      ...(more ? { NextContinuationToken: String(index + 1) } : {}),
    };
  });
}

describe("listBackupsInS3 (step 75)", () => {
  it("reads every page, newest first, with upload time and size", async () => {
    const list = fakeBucket([
      [
        {
          Key: `p/2026-10-10T190000Z${S3_BACKUP_SUFFIX}`,
          LastModified: new Date(NOW.getTime() - 2 * DAY),
          Size: 900,
        },
      ],
      [
        {
          Key: `p/2026-10-11T190000Z${S3_BACKUP_SUFFIX}`,
          LastModified: new Date(NOW.getTime() - DAY),
          Size: 1000,
        },
      ],
    ]);
    const backups = await listBackupsInS3({ bucket: "b", prefix: "p/", list });
    expect(backups.map((b) => b.sizeBytes)).toEqual([1000, 900]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0][0]).toEqual({ Bucket: "b", Prefix: "p/" });
    expect(list.mock.calls[1][0]).toEqual({
      Bucket: "b",
      Prefix: "p/",
      ContinuationToken: "1",
    });
  });

  it("counts only objects named like backup.sh's dumps", async () => {
    const list = fakeBucket([
      [
        { Key: "notes.txt", LastModified: NOW, Size: 5_000_000 },
        { Key: "2026-10-12T190000Z.dump", LastModified: NOW, Size: 5_000_000 },
        {
          Key: `2026-10-11T190000Z${S3_BACKUP_SUFFIX}`,
          LastModified: NOW,
          Size: 2_000_000,
        },
        { Key: `missing-size${S3_BACKUP_SUFFIX}`, LastModified: NOW },
        { LastModified: NOW, Size: 1 },
      ],
    ]);
    expect(await listBackupsInS3({ bucket: "b", list })).toEqual([
      { takenAt: NOW, sizeBytes: 2_000_000 },
    ]);
  });

  it("an empty bucket is no backups, which the check fails as such", async () => {
    const backups = await listBackupsInS3({ bucket: "b", list: fakeBucket([[]]) });
    expect(assessBackups(backups, NOW, { minBytes: 1, maxAgeHours: 36 })).toEqual({
      ok: false,
      reason: "no_backups",
    });
  });

  it("a listing error propagates, for runBackupVerify to record as unreadable", async () => {
    const list = vi
      .fn()
      .mockRejectedValue(new Error("AccessDenied: bucket clausecheck-backups"));
    await expect(listBackupsInS3({ bucket: "b", list })).rejects.toThrow(/AccessDenied/);
  });
});

describe("BACKUP_S3_* in config (step 75)", () => {
  /** @param {Record<string, string>} overrides */
  const env = (overrides) => ({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://test:test@localhost:5432/clausecheck_test",
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_MODEL: "claude-haiku-4-5",
    JWT_SECRET: "test-jwt-secret-at-least-32-bytes-long-ok",
    FRONTEND_ORIGIN: "http://localhost:5173",
    REDIS_URL: "redis://localhost:6379",
    AUDIT_SALT: "test-audit-salt-at-least-32-bytes-long-ok",
    LLM_PRICE_INPUT_PER_MTOK: "2",
    LLM_PRICE_OUTPUT_PER_MTOK: "10",
    MONTHLY_SPEND_CEILING_USD: "10",
    ...overrides,
  });
  const complete = {
    BACKUP_S3_BUCKET: "clausecheck-backups-staging",
    BACKUP_S3_REGION: "ap-southeast-1",
    BACKUP_S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
    BACKUP_S3_SECRET_ACCESS_KEY: "example-secret",
  };

  it("a bucket needs its region and its key, or boot stops naming what is missing", () => {
    for (const missing of [
      "BACKUP_S3_REGION",
      "BACKUP_S3_ACCESS_KEY_ID",
      "BACKUP_S3_SECRET_ACCESS_KEY",
    ]) {
      const partial = /** @type {Record<string, string>} */ ({ ...complete });
      delete partial[missing];
      expect(() => parseConfig(env(partial))).toThrow(new RegExp(missing));
    }
    expect(parseConfig(env(complete)).BACKUP_S3_BUCKET).toBe(
      "clausecheck-backups-staging",
    );
  });

  it("one source: a directory and a bucket together is refused", () => {
    expect(() => parseConfig(env({ ...complete, BACKUP_DIR: "/backups" }))).toThrow(
      /BACKUP_DIR or BACKUP_S3_BUCKET/,
    );
  });

  it("the prefix defaults to the whole bucket", () => {
    expect(parseConfig(env(complete)).BACKUP_S3_PREFIX).toBe("");
  });
});
