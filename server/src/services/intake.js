import config from "../config.js";
import { AppError } from "../lib/AppError.js";
import { detectSourceType } from "../middleware/upload.js";
import { normalize, countWords, hashText } from "./extraction.js";
import { extractInWorker } from "./extractionWorker.js";

/**
 * The intake pipeline (§2.2 steps 1-4's document half; FR-2.1, FR-2.5,
 * FR-2.6, FR-2.8): raw upload bytes or pasted text in, a persistable
 * Document shape out, or the right AppError.
 *
 * Step 18 (documents.js) is the only caller and stores exactly what
 * this returns — sourceType, rawText, wordCount, textSha256, byteSize —
 * alongside the filename and userId it already has.
 *
 * Precedence (matches upload.js's comment, extended one step further):
 *   type detection -> structural limits -> parser errors -> extraction
 *   timeout -> word-count bounds
 * Everything from "structural limits" to "extraction timeout" happens
 * inside the worker (FR-2.11); the timeout is the parent's.
 * A file typed wrong never reaches a parser; a file that fails to parse
 * never reaches the word-count check; both fire before anything is
 * normalised or hashed.
 */

/**
 * FR-2.1 / FR-2.3 — an upload's type comes from detectSourceType
 * (magic bytes only), never from a filename or client MIME type. That
 * decision was already made and tested in step 16; this is its only
 * caller in the intake path.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ sourceType: "UPLOAD_PDF" | "UPLOAD_DOCX", rawText: string, wordCount: number, textSha256: string, byteSize: number }>}
 */
export async function intakeUpload(buffer) {
  const sourceType = detectSourceType(buffer);

  if (sourceType === null) {
    throw new AppError("UNSUPPORTED_FILE_TYPE");
  }

  // FR-2.11 / NFR-1.4 — parsing runs in a worker thread, bounded to ten
  // seconds. Both parsers are synchronous CPU work on a buffer the user
  // chose; on the main thread a pathological document stops the event
  // loop for every other request, not just its own.
  const extracted = await extractInWorker(buffer, sourceType);

  return finalizeIntake(extracted, sourceType);
}

/**
 * The paste path (FR-2.1): no file type to detect, no parser to run —
 * the JSON body's text IS the document. The 1 MB body-size cap is
 * enforced upstream by express.json() (app.js); this function only
 * applies the word-count bounds every intake path shares.
 *
 * @param {string} text
 * @returns {{ sourceType: "PASTE", rawText: string, wordCount: number, textSha256: string, byteSize: number }}
 */
export function intakePastedText(text) {
  return finalizeIntake(text, "PASTE");
}

/**
 * FR-2.5 / FR-2.6 — normalises, counts, hashes, and enforces the word
 * bounds every intake path shares regardless of how the text arrived.
 *
 * byteSize is the byte length of the NORMALISED text (what is actually
 * stored), not the original upload — FR-2.13's 50 MB storage quota is
 * about stored text, and the two can differ (normalisation strips
 * characters and collapses whitespace).
 */
function finalizeIntake(extractedText, sourceType) {
  const rawText = normalize(extractedText);
  const wordCount = countWords(rawText);

  if (wordCount < config.MIN_DOCUMENT_WORDS) {
    throw new AppError("DOCUMENT_TOO_SHORT", { message: tooShortMessage(wordCount) });
  }

  if (wordCount > config.MAX_DOCUMENT_WORDS) {
    throw new AppError("DOCUMENT_TOO_LONG", { message: tooLongMessage(wordCount) });
  }

  return {
    sourceType,
    rawText,
    wordCount,
    textSha256: hashText(rawText),
    byteSize: Buffer.byteLength(rawText, "utf8"),
  };
}

/** en-US grouping to match §4's own example verbatim: "6,200 words". */
const formatCount = (n) => n.toLocaleString("en-US");

/**
 * FR-2.5's required content: the likely cause (a scanned image with no
 * text layer) is the single most common real failure, so it's the
 * headline, not a footnote — with the actual count alongside it for the
 * same reason DOCUMENT_TOO_LONG's message carries one.
 */
function tooShortMessage(wordCount) {
  return (
    `This document is ${formatCount(wordCount)} words — under the ${config.MIN_DOCUMENT_WORDS}-word ` +
    `minimum. This usually means a scanned image with no selectable text. Try a version with real ` +
    `text, or paste the text directly.`
  );
}

/** FR-2.6's exact template from §4's example: "Document is 6,200 words. Phase 1 supports up to 4,000." */
function tooLongMessage(wordCount) {
  return `Document is ${formatCount(wordCount)} words. Phase 1 supports up to ${formatCount(config.MAX_DOCUMENT_WORDS)}.`;
}
