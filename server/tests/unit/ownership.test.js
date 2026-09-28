import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "prom-client";

vi.mock("../../src/lib/prisma.js", () => ({
  default: { document: { findFirst: vi.fn() } },
}));
const { default: prisma } = await import("../../src/lib/prisma.js");
const { loadOwnedDocument } = await import("../../src/lib/ownership.js");
const { AppError } = await import("../../src/lib/AppError.js");

/**
 * FR-1.5's ownership load, and specifically that it passes its result
 * through the cross_user_access assertion (step 68).
 *
 * WHY THIS NEEDS A MOCK, when everything else about ownership is covered by
 * real integration tests: the assertion only fires on a row the query cannot
 * return, so no real database can produce the case. Without this, removing
 * the assertion from ownership.js breaks nothing and no test notices — which
 * is exactly what a mutation of that line showed before this file existed.
 */

afterEach(() => vi.restoreAllMocks());

/**
 * A full Document row. Prisma's generated type is what findFirst resolves to,
 * so a two-field stub does not typecheck — and should not: a test that lies
 * about the shape of a row is a test that can pass while the real thing
 * cannot.
 *
 * @param {{ id?: string, userId: string }} overrides
 * @returns {import("@prisma/client").Document}
 */
function documentRow({ id = "doc_1", userId }) {
  return {
    id,
    userId,
    createdAt: new Date("2026-01-05T00:00:00.000Z"),
    filename: "contract.pdf",
    sourceType: /** @type {import("@prisma/client").SourceType} */ ("UPLOAD"),
    rawText: "DESIGN SERVICES AGREEMENT. The Client may request unlimited revisions.",
    textSha256: "0".repeat(64),
    wordCount: 10,
    byteSize: 70,
  };
}

/** @param {string} name */
async function counterValue(name) {
  const metric = /** @type {import("prom-client").Metric} */ (register.getSingleMetric(name));
  return (await metric.get()).values.reduce((total, v) => total + v.value, 0);
}

describe("loadOwnedDocument", () => {
  it("returns the document the query found", async () => {
    const document = documentRow({ userId: "user_1" });
    vi.mocked(prisma.document.findFirst).mockResolvedValue(document);

    expect(await loadOwnedDocument("doc_1", "user_1")).toBe(document);
    // Scoped by owner in the query itself, which is the control the
    // assertion below is only a backstop for.
    expect(prisma.document.findFirst).toHaveBeenCalledWith({
      where: { id: "doc_1", userId: "user_1" },
    });
  });

  it("is NOT_FOUND, never FORBIDDEN, for a document that is not the caller's", async () => {
    vi.mocked(prisma.document.findFirst).mockResolvedValue(null);
    await expect(loadOwnedDocument("doc_1", "user_1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a document whose owner is not the subject, even if the query returns one", async () => {
    // The query above cannot do this. A later edit that drops `userId` from
    // the where clause can, and this is the line that would catch it.
    vi.mocked(prisma.document.findFirst).mockResolvedValue(documentRow({ userId: "someone-else" }));
    const before = await counterValue("cross_user_access_total");

    await expect(loadOwnedDocument("doc_1", "user_1")).rejects.toBeInstanceOf(AppError);
    await expect(loadOwnedDocument("doc_1", "user_1")).rejects.toMatchObject({ code: "INTERNAL" });
    expect(await counterValue("cross_user_access_total")).toBe(before + 2);
  });
});
