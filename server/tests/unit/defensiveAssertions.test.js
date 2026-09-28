import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "prom-client";
import { AppError } from "../../src/lib/AppError.js";
import {
  assertExcerptsVerified,
  assertOwnDocument,
} from "../../src/lib/defensiveAssertions.js";
import logger from "../../src/observability/logger.js";

/**
 * Appendix C's two Sev-1 assertions (step 68). The integration suite drills
 * them through real requests; this covers the branches directly, including
 * the one that matters most and is hardest to see: what the log line
 * contains.
 */

const CONTRACT =
  "DESIGN SERVICES AGREEMENT. Invoices are payable within ninety (90) days of receipt. " +
  "The Client may request unlimited revisions at no additional cost.";
const REAL = "Invoices are payable within ninety (90) days of receipt.";
const FABRICATED = "The Designer surrenders all rights in perpetuity to any third party.";

/** @param {string} name @param {Record<string, string>} [labels] */
async function counterValue(name, labels = {}) {
  const metric = /** @type {import("prom-client").Metric} */ (
    register.getSingleMetric(name)
  );
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([key, want]) => v.labels[key] === want))
    .reduce((total, v) => total + v.value, 0);
}

/** @type {import("vitest").MockInstance} */
let errorSpy;
beforeEach(() => {
  errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const context = { path: "report", analysisId: "an_1", documentId: "doc_1" };

describe("assertExcerptsVerified", () => {
  it("returns the findings untouched when every excerpt is in the document", async () => {
    const findings = [{ clauseExcerpt: REAL }];
    const before = await counterValue("unverified_excerpt_displayed_total");

    expect(assertExcerptsVerified(findings, CONTRACT, context)).toBe(findings);
    expect(await counterValue("unverified_excerpt_displayed_total")).toBe(before);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does nothing for an analysis with no findings — a clean contract is not a failure", async () => {
    expect(assertExcerptsVerified([], CONTRACT, context)).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("matches the way §5.3 matches: whitespace and case differences are not fabrication", () => {
    // normalizeForMatch is the same function that admitted the finding, so a
    // quote that differs only in spacing or case must not be read as invented.
    const findings = [
      { clauseExcerpt: "invoices   are PAYABLE within ninety (90) days of receipt." },
    ];
    expect(() => assertExcerptsVerified(findings, CONTRACT, context)).not.toThrow();
  });

  it("throws INTERNAL and counts one per unverifiable finding", async () => {
    const findings = [
      { clauseExcerpt: REAL },
      { clauseExcerpt: FABRICATED },
      { clauseExcerpt: "Also absent." },
    ];
    const before = await counterValue("unverified_excerpt_displayed_total", {
      path: "report",
    });

    const err = /** @type {AppError} */ (
      (() => {
        try {
          assertExcerptsVerified(findings, CONTRACT, context);
          return null;
        } catch (caught) {
          return caught;
        }
      })()
    );

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("INTERNAL");
    expect(
      await counterValue("unverified_excerpt_displayed_total", { path: "report" }),
    ).toBe(before + 2);
  });

  it("logs the alert name, the severity and counts — and never the excerpt", () => {
    expect(() =>
      assertExcerptsVerified([{ clauseExcerpt: FABRICATED }], CONTRACT, context),
    ).toThrow();

    const [fields, message] = errorSpy.mock.calls[0];
    expect(fields).toMatchObject({
      alert: "unverified_excerpt_displayed",
      severity: 1,
      path: "report",
      unverified: 1,
      findings: 1,
    });
    // The whole point is that this text is not in the document. A log line is
    // not the place to publish it, and §6.5 bars document content anyway.
    const serialized = JSON.stringify({ fields, message });
    expect(serialized).not.toContain("perpetuity");
    expect(serialized).not.toContain("Invoices are payable");
  });

  it("labels the path it was called from, so the metric says which surface served it", async () => {
    const before = await counterValue("unverified_excerpt_displayed_total", {
      path: "analyze",
    });
    expect(() =>
      assertExcerptsVerified([{ clauseExcerpt: FABRICATED }], CONTRACT, {
        ...context,
        path: "analyze",
      }),
    ).toThrow();
    expect(
      await counterValue("unverified_excerpt_displayed_total", { path: "analyze" }),
    ).toBe(before + 1);
  });
});

describe("assertOwnDocument", () => {
  it("returns the document when the subject owns it, counting nothing", async () => {
    const document = { id: "doc_1", userId: "user_1" };
    const before = await counterValue("cross_user_access_total");

    expect(assertOwnDocument(document, "user_1")).toBe(document);
    expect(await counterValue("cross_user_access_total")).toBe(before);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("throws INTERNAL and counts when it does not", async () => {
    const before = await counterValue("cross_user_access_total");

    expect(() =>
      assertOwnDocument({ id: "doc_1", userId: "owner" }, "someone-else"),
    ).toThrow(AppError);
    expect(await counterValue("cross_user_access_total")).toBe(before + 1);
  });

  it("logs ids and no email address", () => {
    expect(() =>
      assertOwnDocument({ id: "doc_1", userId: "owner" }, "someone-else"),
    ).toThrow();

    const [fields] = errorSpy.mock.calls[0];
    expect(fields).toMatchObject({
      alert: "cross_user_access",
      severity: 1,
      document: { id: "doc_1", ownerId: "owner" },
      subjectId: "someone-else",
    });
    expect(JSON.stringify(fields)).not.toContain("@");
  });
});
