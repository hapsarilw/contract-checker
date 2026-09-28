// SRS §11.3 — fixture generation is itself a test.
//
// expected.json's excerpts are typed by hand against the .docx source text.
// Nothing enforces that they stay verbatim substrings as contracts.js
// changes, and §5.3's matching is exact — a single dropped word silently
// disables the TR-3/TR-7 case it was meant to cover. This script is that
// enforcement: it exits non-zero the moment an excerpt and its document
// disagree.
//
// It imports normalizeForMatch and excerptAppears from src/services/verify.js
// rather than reimplementing the match. A local copy would keep passing
// after the real matcher changed — a green check on a stale algorithm, which
// is worse than no check at all. That is why step 20 (verify.js) came before
// this script.
//
// Document text comes from intakeUpload/intakePastedText (src/services/
// intake.js), the same two entry points production calls, not a bespoke
// extraction here. That gets three things for free instead of reimplemented:
//   - PDF text comes from pdf-parse, the extractor SRS §9 names for
//     production, page markers and all — never pdftotext, which the old
//     README used and which no upload ever goes through.
//   - The document side is normalize()'d (extraction.js) before this script
//     ever sees it, exactly as analysis.js's document.rawText is. FR-2.4
//     folds curly quotes to straight on that side BEFORE §5.3 runs, so this
//     corpus's typographic apostrophes exercise normalizeForMatch's
//     curly-quote branch only from the EXCERPT side — the document side is
//     already straight quotes by the time excerptAppears sees it. That is
//     expected, not a gap: §10.5's 100% branch coverage on verify.js comes
//     from TR-3's unit tests, which drive both sides directly.
//   - A fixture this script cannot even intake (wrong file, corrupted
//     upload) fails loudly here instead of quietly comparing against
//     nothing.
//
// PDFs built by build.js are pinned to a fixed date and so are byte-
// identical across rebuilds, but this script never compares bytes anyway —
// only text extracted through the real pipeline, which is what a match
// against Document.rawText actually depends on.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Must run before intake.js, which transitively imports src/config.js:
// config.js validates process.env at module load and exits the process on
// an invalid one. Vitest gets this via vitest.config.js's setupFiles; this
// script is plain `node`, so it imports the same file itself, first.
import "../setup.js";
import mammoth from "mammoth";
import { intakeUpload, intakePastedText } from "../../src/services/intake.js";
import { normalizeForMatch, excerptAppears } from "../../src/services/verify.js";
import { answerKeyJson } from "./answerKey.js";
import { countZeroWidth } from "./contracts.js";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

/** @param {string} name */
function readFixture(name) {
  return readFileSync(join(FIXTURES_DIR, name));
}

const answerKey = JSON.parse(readFixture("expected.json").toString("utf8"));

/**
 * Every excerpt the answer key claims is real, verbatim text of its
 * document — findings, also_acceptable (a real clause judged low rather
 * than missed), and fair_clauses_do_not_flag (a real clause judged fine).
 * All three are text a correct analyzer's output could legitimately quote,
 * so all three must survive extraction, not just the ones in `findings`.
 *
 * @returns {{ document: string, excerpt: string, source: string }[]}
 */
function excerptsToVerify() {
  const checks = [];
  for (const doc of answerKey.documents) {
    for (const finding of doc.findings ?? []) {
      checks.push({ document: doc.file, excerpt: finding.excerpt, source: "findings" });
    }
    for (const entry of doc.also_acceptable ?? []) {
      checks.push({ document: doc.file, excerpt: entry.excerpt, source: "also_acceptable" });
    }
    for (const entry of doc.fair_clauses_do_not_flag ?? []) {
      checks.push({ document: doc.file, excerpt: entry.excerpt, source: "fair_clauses_do_not_flag" });
    }
    // Fixture 09's injections (TR-15): the POST-normalisation text the model
    // reads, which must be what every format produces once FR-2.4 has run.
    for (const entry of doc.injection ?? []) {
      checks.push({ document: doc.file, excerpt: entry.excerpt, source: "injection" });
    }
  }
  return checks;
}

/** Only these two: the generation constraint (SRS §11.3) names exactly them. */
const CHECKED_FORMATS = /** @type {const} */ (["txt", "pdf"]);

const textCache = new Map();

/**
 * The document text §5.3 would actually see — through intakeUpload/
 * intakePastedText, cached per file so a document shared by several
 * excerpts (or by both the acceptance and the fabricated-excerpt checks)
 * is only extracted once.
 *
 * @param {string} file
 * @param {(typeof CHECKED_FORMATS)[number]} format
 * @returns {Promise<string>}
 */
async function documentText(file, format) {
  const key = `${file}.${format}`;
  if (textCache.has(key)) return textCache.get(key);

  const buffer = readFixture(key);
  const { rawText } = await (format === "txt"
    ? intakePastedText(buffer.toString("utf8"))
    : intakeUpload(buffer));

  textCache.set(key, rawText);
  return rawText;
}

/**
 * @param {string} file
 * @param {string} excerpt
 * @param {string} source
 * @param {boolean} shouldAppear
 * @param {string[]} failures
 */
async function checkAgainstEveryFormat(file, excerpt, source, shouldAppear, failures) {
  const doc = answerKey.documents.find((d) => d.file === file);
  if (!doc) {
    failures.push(`${source}: references unknown document "${file}"`);
    return;
  }

  for (const format of CHECKED_FORMATS) {
    if (!doc.formats.includes(format)) continue;

    const text = await documentText(file, format);
    const found = excerptAppears(excerpt, text);
    if (found === shouldAppear) continue;

    failures.push(
      `${file}.${format}: excerpt from ${source} ${shouldAppear ? "NOT FOUND" : "WAS FOUND (should be absent)"}: ` +
        `${JSON.stringify(excerpt)}\n      normalized: ${JSON.stringify(normalizeForMatch(excerpt))}`,
    );
  }
}

/**
 * The committed files of a document with a disguised injection must still
 * SHIP its zero-width characters, raw, before any normalisation: a rebuild
 * that lost them would leave every other check here passing (they all read
 * normalised text, where the characters are gone either way) while TR-15
 * silently stopped covering the invisible variant.
 *
 * @param {string[]} failures
 */
async function checkZeroWidthShipped(failures) {
  for (const doc of answerKey.documents) {
    for (const entry of (doc.injection ?? []).filter((i) => i.disguised)) {
      const txt = countZeroWidth(readFixture(`${doc.file}.txt`).toString("utf8"));
      const { value } = await mammoth.extractRawText({ buffer: readFixture(`${doc.file}.docx`) });
      const docx = countZeroWidth(value);
      if (!(entry.zero_width_characters > 0) || txt !== entry.zero_width_characters || docx !== entry.zero_width_characters) {
        failures.push(
          `${doc.file}: the answer key declares ${entry.zero_width_characters} zero-width character(s); ` +
            `the committed .txt carries ${txt}, the .docx ${docx}`,
        );
      }
    }
  }
}

/** @param {string[]} failures */
function checkAnswerKeyCurrent(failures) {
  const expected = answerKeyJson((file) => readFixture(`${file}.txt`).toString("utf8"));
  if (readFixture("expected.json").toString("utf8") !== expected) {
    failures.push(
      "expected.json is not what answerKey.js generates: it was edited by hand, or answerKey.js/contracts.js " +
        "changed without `node tests/fixtures/build.js`",
    );
  }
}

async function main() {
  const failures = [];
  checkAnswerKeyCurrent(failures);
  await checkZeroWidthShipped(failures);

  const checks = excerptsToVerify();
  for (const { document, excerpt, source } of checks) {
    await checkAgainstEveryFormat(document, excerpt, source, true, failures);
  }

  for (const entry of answerKey.fabricated_excerpts) {
    await checkAgainstEveryFormat(entry.against, entry.excerpt, "fabricated_excerpts", false, failures);
  }

  if (failures.length > 0) {
    console.error(`${failures.length} fixture verification failure(s):\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `OK: ${checks.length} excerpt(s) verified across ${new Set(checks.map((c) => c.document)).size} ` +
      `document(s), each in ${CHECKED_FORMATS.join(" and ")} form; ` +
      `${answerKey.fabricated_excerpts.length} fabricated excerpt(s) confirmed absent.`,
  );
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exitCode = 1;
});
