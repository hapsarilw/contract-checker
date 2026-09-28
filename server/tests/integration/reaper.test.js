import { describe, it, expect } from "vitest";
import prisma from "../../src/lib/prisma.js";
import {
  reapStaleAnalyses,
  stalePendingAnalysesGauge,
  STALE_THRESHOLD_MS,
} from "../../src/jobs/reaper.js";
import { createAnalysis, createDocument } from "./factories.js";

/**
 * FR-3.8 / SRS §12.3 — TR: a 6-minute-old PENDING row is reaped; a
 * 2-minute-old one is not; two concurrent job runs process each row
 * exactly once.
 *
 * Every test fixes `now` to a real Date and passes it to
 * reapStaleAnalyses() explicitly, rather than letting the row age in
 * real time — the same convention lockout.test.js and quota.test.js use
 * for a time-window guard: the WINDOW is what's under test, not the
 * clock.
 */

const NOW = new Date("2026-06-15T12:00:00.000Z");
const SIX_MINUTES_AGO = new Date(NOW.getTime() - 6 * 60 * 1000);
const TWO_MINUTES_AGO = new Date(NOW.getTime() - 2 * 60 * 1000);

/** A PENDING analysis created at a specific, possibly-stale, moment. */
async function pendingAnalysisAt(createdAt) {
  const document = await createDocument();
  return createAnalysis({
    documentId: document.id,
    status: "PENDING",
    createdAt,
    completedAt: null,
    // A COMPLETED-shaped default (overallRisk, summary...) on a PENDING
    // row would misrepresent what a genuinely-orphaned row looks like;
    // the factory's other defaults (model, documentId) are fine to keep.
    overallRisk: null,
    summary: null,
  });
}

describe("reapStaleAnalyses (FR-3.8, §12.3)", () => {
  it("exactly 5 minutes is the boundary: a 6-minute-old row is stale, a 2-minute-old one is not touched", async () => {
    const stale = await pendingAnalysisAt(SIX_MINUTES_AGO);
    const fresh = await pendingAnalysisAt(TWO_MINUTES_AGO);

    const result = await reapStaleAnalyses(NOW);

    expect(result).toEqual({ lockAcquired: true, staleCountAtStart: 1, reaped: 1 });

    const reapedRow = await prisma.analysis.findUniqueOrThrow({
      where: { id: stale.id },
    });
    expect(reapedRow.status).toBe("FAILED");
    expect(reapedRow.errorCode).toBe("STALE_ANALYSIS");
    expect(reapedRow.completedAt).toEqual(NOW);

    const untouchedRow = await prisma.analysis.findUniqueOrThrow({
      where: { id: fresh.id },
    });
    expect(untouchedRow.status).toBe("PENDING");
    expect(untouchedRow.errorCode).toBeNull();
    expect(untouchedRow.completedAt).toBeNull();
  }, 30_000);

  it("never touches a COMPLETED or already-FAILED row, however old", async () => {
    const longAgo = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const document = await createDocument();
    const completed = await createAnalysis({
      documentId: document.id,
      status: "COMPLETED",
      createdAt: longAgo,
      completedAt: longAgo,
      overallRisk: "LOW",
    });
    const alreadyFailed = await createAnalysis({
      documentId: (await createDocument()).id,
      status: "FAILED",
      createdAt: longAgo,
      completedAt: longAgo,
      errorCode: "LLM_TIMEOUT",
    });

    const result = await reapStaleAnalyses(NOW);
    expect(result.staleCountAtStart).toBe(0);
    expect(result.reaped).toBe(0);

    expect(
      (await prisma.analysis.findUniqueOrThrow({ where: { id: completed.id } })).status,
    ).toBe("COMPLETED");
    const stillFailed = await prisma.analysis.findUniqueOrThrow({
      where: { id: alreadyFailed.id },
    });
    expect(stillFailed.status).toBe("FAILED");
    // Its ORIGINAL error code, not overwritten by the reaper's.
    expect(stillFailed.errorCode).toBe("LLM_TIMEOUT");
  }, 30_000);

  it("sets the gauge to the count of stale rows found, before the sweep — Appendix C's alert reads this", async () => {
    await pendingAnalysisAt(SIX_MINUTES_AGO);
    await pendingAnalysisAt(SIX_MINUTES_AGO);
    await pendingAnalysisAt(TWO_MINUTES_AGO);

    const result = await reapStaleAnalyses(NOW);
    expect(result.staleCountAtStart).toBe(2);

    const metric = await stalePendingAnalysesGauge.get();
    expect(metric.values).toEqual([expect.objectContaining({ value: 2 })]);
  }, 30_000);

  it("boundary: a row exactly STALE_THRESHOLD_MS old is not yet stale (the cutoff is strictly older-than)", async () => {
    const exactlyAtThreshold = new Date(NOW.getTime() - STALE_THRESHOLD_MS);
    const analysis = await pendingAnalysisAt(exactlyAtThreshold);

    const result = await reapStaleAnalyses(NOW);
    expect(result.reaped).toBe(0);

    const row = await prisma.analysis.findUniqueOrThrow({ where: { id: analysis.id } });
    expect(row.status).toBe("PENDING");
  }, 30_000);

  it("two concurrent job runs process each stale row exactly once, proven via the advisory lock, not via the WHERE clause", async () => {
    const rows = await Promise.all([
      pendingAnalysisAt(SIX_MINUTES_AGO),
      pendingAnalysisAt(SIX_MINUTES_AGO),
      pendingAnalysisAt(SIX_MINUTES_AGO),
    ]);

    const [a, b] = await Promise.all([reapStaleAnalyses(NOW), reapStaleAnalyses(NOW)]);

    // pg_try_advisory_xact_lock is non-blocking and resolved atomically by
    // Postgres: of two transactions racing for the same key, exactly one
    // gets true. There is no timing window to get unlucky on.
    const winners = [a, b].filter((r) => r.lockAcquired);
    const losers = [a, b].filter((r) => !r.lockAcquired);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The proof this test exists for: the LOSER did zero work BECAUSE it
    // never held the lock, not because it happened to find nothing left —
    // asserting lockAcquired directly (above) is what distinguishes "the
    // lock serialized these" from "the WHERE clause made a second pass
    // harmless anyway," which updateMany's re-evaluated WHERE would have
    // done even with no lock at all.
    expect(losers[0].reaped).toBe(0);
    expect(winners[0].reaped).toBe(3);

    const failedCount = await prisma.analysis.count({
      where: {
        id: { in: rows.map((r) => r.id) },
        status: "FAILED",
        errorCode: "STALE_ANALYSIS",
      },
    });
    expect(failedCount).toBe(3);
  }, 30_000);
});
