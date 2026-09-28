import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { Registry } from "prom-client";
import prisma from "../../src/lib/prisma.js";
import { createJobLastSuccessGauge, recordJobSuccess } from "../../src/jobs/jobRuns.js";
import { runRetention, retentionTick, BATCH_SIZE } from "../../src/jobs/retention.js";
import { createAnalysis, createDocument, createUser } from "./factories.js";

/**
 * FR-4.4 / SRS §5.6 — the retention job against a real Postgres.
 *
 * Every test pins `now` and passes it in, rather than letting rows age in
 * real time: the WINDOW is what's under test, not the clock. NOW sits
 * inside the 02:00-06:00 UTC nightly window, so a due-check at NOW passes
 * on the window alone.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T03:00:00.000Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY_MS);

/** A document of a given age, with an analysis and two findings under it. */
async function documentWithDescendantsAt(createdAt) {
  const document = await createDocument({ createdAt });
  const analysis = await createAnalysis({
    documentId: document.id,
    findings: [{ severity: "HIGH" }, { severity: "LOW" }],
  });
  return { document, analysis };
}

/** Rows in each table under one document, counted directly — not through any read path. */
async function countTreeUnder(documentId) {
  const [documents, analyses, findings] = await Promise.all([
    prisma.document.count({ where: { id: documentId } }),
    prisma.analysis.count({ where: { documentId } }),
    prisma.finding.count({ where: { analysis: { documentId } } }),
  ]);
  return { documents, analyses, findings };
}

/** The gauge's value for one job, read the way a scrape would read it. */
async function gaugeValue(gauge, job = "retention") {
  const metric = await gauge.get();
  return metric.values.find((v) => v.labels.job === job)?.value;
}

describe("runRetention — documents and descendants (RETENTION_DAYS = 90)", () => {
  it("deletes a 91-day-old document and every descendant, and keeps an 89-day-old one whole", async () => {
    const old = await documentWithDescendantsAt(daysAgo(91));
    const young = await documentWithDescendantsAt(daysAgo(89));

    // Anti-vacuity: both trees are fully populated before the run.
    expect(await countTreeUnder(old.document.id)).toEqual({ documents: 1, analyses: 1, findings: 2 });
    expect(await countTreeUnder(young.document.id)).toEqual({ documents: 1, analyses: 1, findings: 2 });

    const result = await runRetention(NOW);

    expect(result.documents).toEqual({ deleted: 1, batches: 1 });
    // The cascade removed the descendants; nothing in this job deletes them
    // by hand, and this is what proves the schema's cascade did it.
    expect(await countTreeUnder(old.document.id)).toEqual({ documents: 0, analyses: 0, findings: 0 });
    expect(await countTreeUnder(young.document.id)).toEqual({ documents: 1, analyses: 1, findings: 2 });
  }, 30_000);

  it("a document exactly RETENTION_DAYS old is kept — the cutoff is strictly older-than", async () => {
    const { document } = await documentWithDescendantsAt(daysAgo(90));
    await runRetention(NOW);
    expect(await prisma.document.count({ where: { id: document.id } })).toBe(1);
  }, 30_000);

  it("deletes the user's documents, never the user", async () => {
    const user = await createUser();
    await createDocument({ userId: user.id, createdAt: daysAgo(120) });
    await runRetention(NOW);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);
  }, 30_000);
});

describe("runRetention — batching (§5.6: batches of 500)", () => {
  it("deletes more than one batch's worth, in the number of batches that implies", async () => {
    const user = await createUser();
    const total = BATCH_SIZE * 2 + 201; // 1,201: two full batches and a partial third
    await prisma.document.createMany({
      data: Array.from({ length: total }, () => ({
        userId: user.id,
        sourceType: "PASTE",
        rawText: "retention batching fixture",
        textSha256: randomUUID(),
        wordCount: 3,
        byteSize: 26,
        createdAt: daysAgo(100),
      })),
    });
    const keeper = await createDocument({ userId: user.id, createdAt: daysAgo(10) });

    const result = await runRetention(NOW);

    // `batches` is what shows the deletes were BOUNDED rather than one
    // unbounded statement that happens to give the same final count.
    expect(result.documents).toEqual({ deleted: total, batches: 3 });
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.document.count({ where: { id: keeper.id } })).toBe(1);
  }, 60_000);
});

describe("runRetention — expired AuthTokens (7 days past expiry) and AuditEvents (13 months)", () => {
  it("removes a token 8 days past expiry and keeps one 6 and a half days past expiry and one still live", async () => {
    const user = await createUser();
    const token = (expiresAt) =>
      prisma.authToken.create({
        data: { userId: user.id, type: "PASSWORD_RESET", tokenHash: randomUUID(), expiresAt },
      });
    const longExpired = await token(daysAgo(8));
    // Between 6 and 7 days past expiry, for the same reason as the audit
    // test below: a token exactly 6 days past expiry would sit on a
    // 6-day cutoff and survive either way, so a grace period one day too
    // short would go unnoticed.
    const recentlyExpired = await token(daysAgo(6.5));
    const live = await token(new Date(NOW.getTime() + DAY_MS));

    const result = await runRetention(NOW);

    expect(result.authTokens?.deleted).toBe(1);
    expect(await prisma.authToken.count({ where: { id: longExpired.id } })).toBe(0);
    expect(await prisma.authToken.count({ where: { id: recentlyExpired.id } })).toBe(1);
    expect(await prisma.authToken.count({ where: { id: live.id } })).toBe(1);
  }, 30_000);

  it("removes an audit row 14 months old and keeps one 12 and a half months old", async () => {
    const audit = (createdAt) =>
      prisma.auditEvent.create({
        data: { subjectHash: randomUUID(), action: "LOGIN_SUCCEEDED", createdAt },
      });
    const fourteenMonths = await audit(new Date("2025-04-15T03:00:00.000Z"));
    // Between 12 and 13 months old, deliberately: this is the row a
    // retention window one month too short would delete. A row exactly 12
    // months old would sit ON a 12-month cutoff and survive either way,
    // which is how an earlier version of this test let a 13 -> 12
    // mutation through.
    const twelveAndAHalfMonths = await audit(new Date("2025-05-30T03:00:00.000Z"));

    const result = await runRetention(NOW);

    expect(result.auditEvents?.deleted).toBe(1);
    expect(await prisma.auditEvent.count({ where: { id: fourteenMonths.id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { id: twelveAndAHalfMonths.id } })).toBe(1);
  }, 30_000);
});

describe("the last-success timestamp (step 61's cross-instance requirement)", () => {
  it("updates on a successful run and reads the same value from a second instance that never ran the job", async () => {
    // INSTANCE B: its own registry, its own gauge, created before the run
    // and never touched by it. If the value lived in the winning process's
    // memory, this gauge would still read "never" after the run.
    const instanceB = createJobLastSuccessGauge({ registers: [new Registry()] });
    expect(await gaugeValue(instanceB)).toBe(0);

    await runRetention(NOW);

    const row = await prisma.jobRun.findUniqueOrThrow({ where: { job: "retention" } });
    expect(row.lastSuccessAt).toEqual(NOW);

    const nowSeconds = Math.floor(NOW.getTime() / 1000);
    expect(await gaugeValue(instanceB)).toBe(nowSeconds);
  }, 30_000);

  it("reports a never-run job as 0 rather than omitting it, so an alert on staleness has a series to fire on", async () => {
    const gauge = createJobLastSuccessGauge({ registers: [new Registry()] });
    const metric = await gauge.get();
    expect(metric.values).toEqual([expect.objectContaining({ labels: { job: "retention" }, value: 0 })]);
  }, 30_000);

  it("a run that loses the lock does not record a success", async () => {
    const before = new Date(NOW.getTime() - 2 * DAY_MS);
    await recordJobSuccess("retention", before);

    await prisma.$transaction(async (tx) => {
      // Hold the lock from outside, the way a second instance would.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('retention:nightly'))`;
      const result = await runRetention(NOW);
      expect(result).toEqual({ lockAcquired: false, ran: false });
    });

    const row = await prisma.jobRun.findUniqueOrThrow({ where: { job: "retention" } });
    expect(row.lastSuccessAt).toEqual(before);
  }, 30_000);
});

describe("exclusivity and the nightly due-check", () => {
  it("two concurrent runs: exactly one holds the lock", async () => {
    const user = await createUser();
    await prisma.document.createMany({
      data: Array.from({ length: 50 }, () => ({
        userId: user.id,
        sourceType: "PASTE",
        rawText: "concurrency fixture",
        textSha256: randomUUID(),
        wordCount: 2,
        byteSize: 19,
        createdAt: daysAgo(100),
      })),
    });

    const [a, b] = await Promise.all([runRetention(NOW), runRetention(NOW)]);
    expect([a, b].filter((r) => r.lockAcquired)).toHaveLength(1);
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(0);
  }, 30_000);

  it("a second tick the same night does nothing: the due-check runs inside the lock and sees the first run", async () => {
    const first = await retentionTick(NOW);
    expect(first.ran).toBe(true);

    // A document that becomes eligible between the two ticks proves the
    // second tick really skipped, rather than running and finding nothing.
    const { document } = await documentWithDescendantsAt(daysAgo(95));
    const second = await retentionTick(new Date(NOW.getTime() + 60 * 60 * 1000));

    expect(second).toEqual({ lockAcquired: true, ran: false });
    expect(await prisma.document.count({ where: { id: document.id } })).toBe(1);
  }, 30_000);
});
