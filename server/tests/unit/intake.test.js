import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { intakeUpload, intakePastedText } from "../../src/services/intake.js";
import { countWords } from "../../src/services/extraction.js";
import { buildDocx } from "../helpers/buildDocx.js";
import { AppError } from "../../src/lib/AppError.js";
import config from "../../src/config.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const readFixture = (name) => readFileSync(join(fixturesDir, name));

/** n whitespace-separated tokens, nothing else — exactly n words after normalize()/countWords(). */
const wordsOfLength = (n) => Array(n).fill("word").join(" ");

/**
 * TR-1 (SRS §10.1): valid PDF extracts; valid DOCX extracts; the scanned
 * PDF returns DOCUMENT_TOO_SHORT; a mismatched extension returns
 * UNSUPPORTED_FILE_TYPE.
 */
describe("TR-1 — intake extraction outcomes", () => {
  it("a valid PDF extracts (01-design-services-hostile.pdf)", async () => {
    const result = await intakeUpload(readFixture("01-design-services-hostile.pdf"));

    expect(result.sourceType).toBe("UPLOAD_PDF");
    expect(result.rawText).toContain("DESIGN SERVICES AGREEMENT");
    expect(result.wordCount).toBeGreaterThan(config.MIN_DOCUMENT_WORDS);
    expect(result.wordCount).toBeLessThan(config.MAX_DOCUMENT_WORDS);
    expect(result.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.byteSize).toBe(Buffer.byteLength(result.rawText, "utf8"));
  });

  it("a valid DOCX extracts", async () => {
    const docx = await buildDocx({
      paragraphs: [wordsOfLength(250)], // comfortably clears the 200-word floor
    });
    const result = await intakeUpload(docx);

    expect(result.sourceType).toBe("UPLOAD_DOCX");
    expect(result.wordCount).toBe(250);
  });

  it("the scanned PDF with no text layer returns DOCUMENT_TOO_SHORT (06-scanned-no-text-layer.pdf)", async () => {
    const err = await intakeUpload(readFixture("06-scanned-no-text-layer.pdf")).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("DOCUMENT_TOO_SHORT");
    expect(err.status).toBe(422);
    // FR-2.5: the message must note the likely cause.
    expect(err.message).toMatch(/scanned image/i);
  });

  it("a mismatched extension (renamed .txt) returns UNSUPPORTED_FILE_TYPE", async () => {
    // The upload has been typed as a PDF by whoever renamed it, but its
    // magic bytes say otherwise — detectSourceType (step 16), not the
    // extension, decides. No parser ever runs on this input.
    const renamed = Buffer.from(
      "INDEPENDENT CONTRACTOR AGREEMENT\nplain text content",
      "utf8",
    );
    const err = await intakeUpload(renamed).catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("UNSUPPORTED_FILE_TYPE");
    expect(err.status).toBe(422);
  });
});

/**
 * SRS §11.1 — every fixture file meets the intake outcome its answer key
 * records, through the path a user's file takes: uploads typed by magic
 * bytes, .txt through the paste path. This is where fixture 02's PDF and
 * DOCX are accepted and fixture 05 is rejected on length in every format.
 * A fixture that intake rejects for the wrong reason, such as a DOCX whose
 * package type detection does not recognise, tests nothing downstream.
 */
describe("the fixture corpus meets its answer key's intake outcomes (§11.1)", () => {
  const answerKey = JSON.parse(readFixture("expected.json").toString("utf8"));

  /** @type {[string, string][]} */
  const cases = answerKey.documents.flatMap((document) =>
    document.formats.map((format) => [
      `${document.file}.${format}`,
      document.intake === "accept" ? "accept" : document.expect_error.code,
    ]),
  );

  it.each(cases)("%s: %s", async (file, expected) => {
    const buffer = readFixture(file);
    const intake = file.endsWith(".txt")
      ? Promise.resolve().then(() => intakePastedText(buffer.toString("utf8")))
      : intakeUpload(buffer);

    const outcome = await intake.then(
      () => "accept",
      (err) => (err instanceof AppError ? err.code : `unexpected: ${err}`),
    );
    expect(outcome).toBe(expected);
  });

  /** @type {[string, number][]} */
  const counted = answerKey.documents
    .filter(
      (document) => document.word_count !== undefined && document.formats.includes("txt"),
    )
    .map((document) => [document.file, document.word_count]);

  it.each(counted)("%s.txt has the answer key's word count, %i", (file, expected) => {
    expect(countWords(readFixture(`${file}.txt`).toString("utf8"))).toBe(expected);
  });
});

describe("a truncated/corrupt PDF returns 422, never 500", () => {
  it("propagates MALFORMED_DOCUMENT through the full intake path, not just extractPdfText directly", async () => {
    const truncated = readFixture("01-design-services-hostile.pdf").subarray(0, 200);
    const err = await intakeUpload(truncated).catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("MALFORMED_DOCUMENT");
    expect(err.status).toBe(422);
  });
});

describe("word-count bounds (FR-2.5, FR-2.6)", () => {
  it("accepts exactly the minimum — the lower bound is inclusive", () => {
    const result = intakePastedText(wordsOfLength(config.MIN_DOCUMENT_WORDS));
    expect(result.wordCount).toBe(config.MIN_DOCUMENT_WORDS);
  });

  it("rejects one word under the minimum", () => {
    const err = () => intakePastedText(wordsOfLength(config.MIN_DOCUMENT_WORDS - 1));
    expect(err).toThrow(AppError);
    try {
      err();
    } catch (e) {
      expect(/** @type {AppError} */ (e).code).toBe("DOCUMENT_TOO_SHORT");
    }
  });

  it("accepts exactly the maximum — the upper bound is inclusive", () => {
    const result = intakePastedText(wordsOfLength(config.MAX_DOCUMENT_WORDS));
    expect(result.wordCount).toBe(config.MAX_DOCUMENT_WORDS);
  });

  it("rejects one word over the maximum, with the actual count and the limit in the message (FR-2.6)", () => {
    const overLimit = config.MAX_DOCUMENT_WORDS + 1;
    /** @type {AppError | undefined} */
    let caught;
    try {
      intakePastedText(wordsOfLength(overLimit));
    } catch (e) {
      caught = /** @type {AppError} */ (e);
    }
    if (!caught) throw new Error("expected intakePastedText to throw");

    expect(caught).toBeInstanceOf(AppError);
    expect(caught.code).toBe("DOCUMENT_TOO_LONG");
    expect(caught.message).toContain(overLimit.toLocaleString("en-US"));
    expect(caught.message).toContain(config.MAX_DOCUMENT_WORDS.toLocaleString("en-US"));
  });

  it("formats the too-short message with the actual count too", () => {
    const shortBy1 = config.MIN_DOCUMENT_WORDS - 1;
    /** @type {AppError | undefined} */
    let caught;
    try {
      intakePastedText(wordsOfLength(shortBy1));
    } catch (e) {
      caught = /** @type {AppError} */ (e);
    }
    if (!caught) throw new Error("expected intakePastedText to throw");
    expect(caught.message).toContain(shortBy1.toLocaleString("en-US"));
  });
});

describe("intakePastedText (FR-2.1 paste path)", () => {
  it("normalises before counting and hashing", () => {
    // Curly quotes fold to straight ones (FR-2.4 step 2), which changes
    // both the word boundary behaviour is irrelevant to here and the
    // byte length — this proves normalisation actually ran, not just
    // that the function returned something.
    const withCurlyQuotes = `${wordsOfLength(200)} “curly” 'quoted' text`;
    const result = intakePastedText(withCurlyQuotes);

    expect(result.rawText).not.toContain("“");
    expect(result.rawText).toContain('"curly"');
  });

  it("byteSize reflects the STORED (normalised) text, not the raw input", () => {
    // Curly quotes are 3 bytes each in UTF-8; straight quotes are 1.
    // Folding them shrinks the byte count — proving byteSize is computed
    // from rawText (post-normalisation), not from the original input.
    const withCurlyQuotes = `${wordsOfLength(200)} “quoted”`;
    const result = intakePastedText(withCurlyQuotes);

    expect(result.byteSize).toBe(Buffer.byteLength(result.rawText, "utf8"));
    expect(result.byteSize).toBeLessThan(Buffer.byteLength(withCurlyQuotes, "utf8"));
  });

  it("produces a deterministic hash for identical text", () => {
    const text = wordsOfLength(300);
    expect(intakePastedText(text).textSha256).toBe(intakePastedText(text).textSha256);
  });

  it("sets sourceType to PASTE", () => {
    expect(intakePastedText(wordsOfLength(200)).sourceType).toBe("PASTE");
  });
});
