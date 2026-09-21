import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../../src/lib/AppError.js";
import { intakeUpload } from "../../src/services/intake.js";
import { extractDocxText } from "../../src/services/docx.js";
import { extractPdfText } from "../../src/services/pdf.js";
import { MAX_ENTRIES, MAX_EXPANSION_RATIO, MAX_UNCOMPRESSED_BYTES } from "../../src/services/zipLimits.js";
import { buildDocx } from "../helpers/buildDocx.js";
import {
  buildManyEntryDocx,
  buildPdf,
  buildTruncatedPdf,
  buildZipBomb,
  lieAboutUncompressedSizes,
} from "../helpers/hostileFiles.js";

/**
 * TR-18 (SRS §10.3) — structural limits: FR-2.9 and FR-2.10.
 *
 * Every limit here runs BEFORE the parser, which is the point rather than
 * an optimisation: a cap checked after extraction has already let the
 * hostile file do the thing the cap existed to prevent. The tests
 * therefore assert not only the status but WHICH CHECK FIRED, through the
 * `details.limit` each AppError carries.
 *
 * The hostile files are built here rather than committed — see
 * tests/helpers/hostileFiles.js for why.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** The AppError a call threw, or a failure if it unexpectedly succeeded. */
async function errorFrom(promise) {
  try {
    await promise;
    throw new Error("expected this to be rejected, but it resolved");
  } catch (err) {
    return /** @type {AppError & { details?: Record<string, unknown> }} */ (err);
  }
}

describe("FR-2.9 — archive-bomb limits, before mammoth opens the file", () => {
  it("rejects an archive that declares more than 50 MB uncompressed", async () => {
    const err = await errorFrom(extractDocxText(await buildZipBomb({ megabytes: 60 })));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("MALFORMED_DOCUMENT");
    expect(err.details).toMatchObject({ limit: "uncompressed", max: MAX_UNCOMPRESSED_BYTES });
  }, 60_000);

  it("rejects an expansion ratio over 100:1 even while under the size cap", async () => {
    // 10 MB of zeros is well under 50 MB but compresses about 1000:1, so
    // only the ratio limit can catch it. Without that limit a 10 KB
    // upload would still cost 10 MB of memory per request.
    const err = await errorFrom(extractDocxText(await buildZipBomb({ megabytes: 10 })));
    expect(err.details).toMatchObject({ limit: "ratio", max: MAX_EXPANSION_RATIO });
    expect(Number(err.details?.ratio)).toBeGreaterThan(MAX_EXPANSION_RATIO);
  }, 60_000);

  it("rejects an archive with more than 500 entries", async () => {
    const err = await errorFrom(extractDocxText(await buildManyEntryDocx(MAX_ENTRIES + 100)));
    expect(err.details).toMatchObject({ limit: "entries", max: MAX_ENTRIES });
  }, 60_000);

  it("catches a bomb whose header LIES about its size — the check that matters", async () => {
    // The declared sizes come from whoever built the file. This one says
    // 1 KB per entry and actually expands to 60 MB, so every header check
    // passes and only the measured expansion can stop it. An
    // implementation that trusted the directory would pass every test
    // above and fail this one.
    const honest = await buildZipBomb({ megabytes: 60 });
    const lying = lieAboutUncompressedSizes(honest);

    const err = await errorFrom(extractDocxText(lying));
    expect(err.code).toBe("MALFORMED_DOCUMENT");
    expect(err.details).toMatchObject({ limit: "actual-uncompressed" });
  }, 60_000);

  it("lets an ordinary DOCX through untouched", async () => {
    // The limits must not be a tax on the common case.
    const docx = await buildDocx({ paragraphs: ["A perfectly ordinary consulting agreement."] });
    await expect(extractDocxText(docx)).resolves.toContain("ordinary consulting agreement");
  });

  it("reports a non-archive as MALFORMED_DOCUMENT rather than throwing raw", async () => {
    const err = await errorFrom(extractDocxText(Buffer.from("PK\u0003\u0004 and then nothing useful")));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("MALFORMED_DOCUMENT");
  });
});

describe("FR-2.10 — PDF limits, before text extraction", () => {
  it("rejects a 200-page PDF on the PAGE COUNT, not the word cap", async () => {
    const err = await errorFrom(extractPdfText(await buildPdf({ pages: 200 })));
    expect(err.code).toBe("DOCUMENT_TOO_LONG");
    expect(err.details).toMatchObject({ limit: "pages", pages: 200 });
    expect(err.message).toMatch(/200 pages/);
  }, 60_000);

  it("returns ENCRYPTED_DOCUMENT for a password-protected PDF, asking for an unlocked copy", async () => {
    const err = await errorFrom(extractPdfText(await buildPdf({ password: "secret" })));
    expect(err.code).toBe("ENCRYPTED_DOCUMENT");
    // Before step 48 this was MALFORMED_DOCUMENT — never a 500, but a
    // message that sent the user hunting for corruption in a file that is
    // merely locked.
    expect(err.code).not.toBe("MALFORMED_DOCUMENT");
  }, 30_000);

  it("returns 422 MALFORMED_DOCUMENT for a truncated PDF, never a 500", async () => {
    const err = await errorFrom(extractPdfText(await buildTruncatedPdf()));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("MALFORMED_DOCUMENT");
    expect(err.status).toBe(422);
  }, 30_000);

  it("lets an ordinary PDF through", async () => {
    await expect(extractPdfText(await buildPdf({ text: "SERVICES AGREEMENT" }))).resolves.toContain(
      "SERVICES AGREEMENT",
    );
  }, 30_000);
});

describe("fixtures 05 and 12 both end in DOCUMENT_TOO_LONG, by different requirements", () => {
  /**
   * The step calls this out explicitly: the two must be distinguished by
   * WHICH CHECK FIRED, not by the error code, or one of the two proves
   * nothing. Fixture 05 is an oversized contract — few pages, far too
   * many words — and 12 is a 200-page PDF that would be refused however
   * few words it held.
   */
  it("05 fires the FR-2.6 word cap, AFTER extraction — no page limit involved", async () => {
    const oversized = readFileSync(join(FIXTURES, "05-oversized-msa.pdf"));
    const err = await errorFrom(intakeUpload(oversized));

    expect(err.code).toBe("DOCUMENT_TOO_LONG");
    expect(err.details?.limit).not.toBe("pages");
    // The word-cap message carries a word count; the page-cap message
    // carries a page count. Different checks, different evidence.
    expect(err.message).toMatch(/words/);
  }, 60_000);

  it("12 fires the FR-2.10 page cap, BEFORE extraction — no word count involved", async () => {
    const err = await errorFrom(intakeUpload(await buildPdf({ pages: 200 })));

    expect(err.code).toBe("DOCUMENT_TOO_LONG");
    expect(err.details).toMatchObject({ limit: "pages" });
    expect(err.message).toMatch(/pages/);
    expect(err.message).not.toMatch(/words/);
  }, 60_000);
});
