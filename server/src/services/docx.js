import mammoth from "mammoth";
import { AppError } from "../lib/AppError.js";
import { assertArchiveWithinLimits } from "./zipLimits.js";

/**
 * FR-2.9 / FR-2.10 — extracts raw text from a DOCX buffer. Same contract
 * as pdf.js: any parser failure becomes 422 MALFORMED_DOCUMENT, never an
 * unhandled 500. Since step 48 the archive's structure is checked first
 * (zipLimits.js), so a bomb is refused without mammoth ever opening it.
 *
 * Measured, not assumed: mammoth throws a plain `Error` (no named
 * exception class) for both "not a ZIP at all" and "a ZIP with a
 * corrupted central directory" — there is nothing finer to branch on
 * here, so the catch is a deliberate catch-all, not a shortcut around
 * one that should be narrower.
 *
 * `messages` (mammoth's second return field) reports non-fatal
 * formatting fidelity warnings — an unsupported style, an unrecognised
 * numbering — not extraction failures. They are discarded: nothing in
 * the spec asks for them, and surfacing "your document used a style we
 * don't understand" would be noise the user cannot act on.
 */
export async function extractDocxText(buffer) {
  // FR-2.9, BEFORE mammoth sees the buffer. A limit checked after the
  // parser has already expanded the archive is not a limit — the memory
  // it was meant to protect has been spent by the time it fires.
  await assertArchiveWithinLimits(buffer);

  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch {
    // As in pdf.js: the underlying error is discarded rather than
    // logged, since it can quote the document's internal XML and FR-2.7
    // bars document content from logs.
    throw new AppError("MALFORMED_DOCUMENT");
  }
}
