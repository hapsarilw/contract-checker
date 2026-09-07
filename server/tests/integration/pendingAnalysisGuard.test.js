import { describe, it, expect } from "vitest";
import prisma from "../../src/lib/prisma.js";
import { createDocument } from "./factories.js";
import { isPendingAnalysisConflict, mapPendingAnalysisConflict } from "../../src/lib/prismaErrors.js";
import { AppError } from "../../src/lib/AppError.js";
import { ERROR_CODES } from "../../src/lib/errorCodes.js";
import { randomUUID } from "node:crypto";

/**
 * FR-3.8 against a REAL Postgres. A partial unique index cannot be
 * exercised by a mock: the whole point is that the database, not the
 * application, arbitrates between two concurrent writers.
 *
 * The container, migrations, and truncation-between-tests all come from
 * the shared harness (globalSetup.js, setup.js) wired into the
 * "integration" project in vitest.config.js — this file used to run its
 * own container (step 10, before the shared harness existed).
 */

const pendingAnalysis = (documentId) => ({
  data: { documentId, status: /** @type {const} */ ("PENDING"), model: "claude-haiku-4-5" },
});

describe("the pending-analysis guard (FR-3.8)", () => {
  it("lets exactly one of two PARALLEL PENDING inserts succeed", async () => {
    const document = await createDocument();

    // Promise.all, not sequential awaits. A sequential test passes
    // against a broken implementation, because the second insert sees
    // the first already committed — it never actually races the index.
    const results = await Promise.allSettled([
      prisma.analysis.create(pendingAnalysis(document.id)),
      prisma.analysis.create(pendingAnalysis(document.id)),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await prisma.analysis.count({ where: { documentId: document.id } })).toBe(1);
  });

  it("maps the losing insert to 409 ANALYSIS_IN_PROGRESS", async () => {
    const document = await createDocument();

    const results = await Promise.allSettled([
      prisma.analysis.create(pendingAnalysis(document.id)),
      prisma.analysis.create(pendingAnalysis(document.id)),
    ]);
    const rejection = results.find((r) => r.status === "rejected");
    if (!rejection) throw new Error("expected one insert to be rejected by the index");

    expect(isPendingAnalysisConflict(rejection.reason)).toBe(true);

    const mapped = mapPendingAnalysisConflict(rejection.reason);
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.code).toBe("ANALYSIS_IN_PROGRESS");
    expect(mapped.status).toBe(409);
    expect(mapped.status).toBe(ERROR_CODES.ANALYSIS_IN_PROGRESS.status);
  });

  it("allows a second analysis once the first is no longer PENDING", async () => {
    const document = await createDocument();

    const first = await prisma.analysis.create(pendingAnalysis(document.id));
    await prisma.analysis.update({
      where: { id: first.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    // The index is PARTIAL — it constrains PENDING rows only. A plain
    // unique index on documentId would wrongly reject this, permitting
    // only one analysis per document for all time.
    const second = await prisma.analysis.create(pendingAnalysis(document.id));
    expect(second.id).not.toBe(first.id);
    expect(await prisma.analysis.count({ where: { documentId: document.id } })).toBe(2);
  });

  it("constrains per document, not globally — two documents can each have one PENDING", async () => {
    const [a, b] = await Promise.all([createDocument(), createDocument()]);

    const results = await Promise.allSettled([
      prisma.analysis.create(pendingAnalysis(a.id)),
      prisma.analysis.create(pendingAnalysis(b.id)),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("does not misclassify an unrelated unique-constraint violation", async () => {
    const email = `${randomUUID()}@example.test`;
    await prisma.user.create({ data: { email, passwordHash: "hash" } });

    const duplicate = await prisma.user
      .create({ data: { email, passwordHash: "hash" } })
      .catch((err) => err);

    // Also P2002, but a different constraint — mapping this to 409
    // ANALYSIS_IN_PROGRESS would disguise a real error.
    expect(duplicate.code).toBe("P2002");
    expect(isPendingAnalysisConflict(duplicate)).toBe(false);
    expect(mapPendingAnalysisConflict(duplicate)).toBe(duplicate);
  });
});
