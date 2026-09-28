import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractPdfText } from "../../src/services/pdf.js";
import { AppError } from "../../src/lib/AppError.js";
import { countWords } from "../../src/services/extraction.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const readFixture = (name) => readFileSync(join(fixturesDir, name));

describe("extractPdfText (FR-2.10)", () => {
  it("extracts real text from a valid PDF", async () => {
    const text = await extractPdfText(readFixture("01-design-services-hostile.pdf"));
    expect(text).toContain("DESIGN SERVICES AGREEMENT");
    expect(text.length).toBeGreaterThan(1000);
  });

  it("extracts a scanned PDF's text without throwing — it is a valid PDF with no useful content, not a parser failure", async () => {
    // Measured: pdf-parse@2.x does not return an empty string here. It
    // emits page-separator boilerplate ("-- 1 of 3 --") between pages
    // even when there is no real text layer. This function's job is
    // just "did the parser succeed", so it returns that text as-is —
    // whether it counts as too short to analyse is intake.js's job
    // (FR-2.5), downstream of this.
    const text = await extractPdfText(readFixture("06-scanned-no-text-layer.pdf"));
    expect(text).toContain("-- 1 of 3 --");
    // The whole reason this fixture works as a DOCUMENT_TOO_SHORT case:
    // the boilerplate itself is short enough to stay under the 200-word
    // floor. If a future pdf-parse version made this text longer, the
    // fixture would silently stop testing what it claims to.
    expect(countWords(text)).toBeLessThan(200);
  });

  it("throws AppError MALFORMED_DOCUMENT for a truncated PDF, never an unhandled error", async () => {
    const truncated = readFixture("01-design-services-hostile.pdf").subarray(0, 100);
    const err = await extractPdfText(truncated).catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("MALFORMED_DOCUMENT");
    expect(err.status).toBe(422);
  });

  it("throws MALFORMED_DOCUMENT for bytes that are not a PDF at all", async () => {
    const err = await extractPdfText(Buffer.from("not a pdf, just text", "utf8")).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("MALFORMED_DOCUMENT");
  });

  it("throws MALFORMED_DOCUMENT for an empty buffer", async () => {
    const err = await extractPdfText(Buffer.alloc(0)).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("MALFORMED_DOCUMENT");
  });

  it("never leaks the underlying parser error into the thrown AppError's message", async () => {
    // FR-2.7: document content never reaches logs or error bodies. The
    // underlying pdf.js exception can quote the file's internal
    // structure — the AppError message must be the generic, static one,
    // not something built from the parser's own error text.
    const err = await extractPdfText(Buffer.alloc(0)).catch((e) => e);
    expect(err.message).not.toMatch(/pdf|byte|structure/i);
  });
});
