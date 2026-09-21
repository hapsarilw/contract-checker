import { PDFParse, PasswordException } from "pdf-parse";
import config from "../config.js";
import { AppError } from "../lib/AppError.js";

/**
 * FR-2.10 — extracts raw text from a PDF buffer. Any parser failure
 * becomes 422 MALFORMED_DOCUMENT; it never reaches the global handler as
 * an unhandled 500. A malformed upload is the user's problem to fix, and
 * reporting it as a server error would both mislabel that and hide real
 * defects in the error-rate metric.
 *
 * Step 48 added FR-2.10's other two clauses, both of which run BEFORE
 * text extraction — the point is to avoid parsing hostile input at all,
 * so a check placed after the parser defeats itself:
 *
 *   over 100 pages    -> 422 DOCUMENT_TOO_LONG, from the page count
 *                        alone. 100 pages cannot survive the 4,000-word
 *                        cap, so nothing is lost by refusing early.
 *   encrypted         -> 422 ENCRYPTED_DOCUMENT, asking for an unlocked
 *                        copy. Until step 48 this was reported as
 *                        MALFORMED_DOCUMENT: never a 500, but a message
 *                        that sent the user looking for corruption in a
 *                        file that is merely locked.
 *
 * `getInfo()` reads the document catalogue and page tree without
 * rendering or extracting any page content, which is what makes it the
 * cheap gate rather than a second parse.
 *
 * Returns the RAW extracted text, unnormalised. Normalisation is
 * extraction.js's job (step 15) and callers apply it — this function's
 * only responsibility is turning bytes into a string or a 422.
 */
export async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    // FR-2.10, before extraction. A PasswordException from getInfo() is
    // the encrypted case: pdf.js needs the password to read the catalogue
    // at all, so this is where it surfaces.
    let info;
    try {
      info = await parser.getInfo();
    } catch (err) {
      if (err instanceof PasswordException) throw new AppError("ENCRYPTED_DOCUMENT");
      throw err;
    }

    if (typeof info.total === "number" && info.total > config.MAX_PDF_PAGES) {
      throw new AppError("DOCUMENT_TOO_LONG", {
        message:
          `This PDF has ${info.total.toLocaleString("en-US")} pages. ` +
          `Phase 1 supports up to ${config.MAX_PDF_PAGES}.`,
        // Which check fired. Fixtures 05 and 12 both end in
        // DOCUMENT_TOO_LONG but through different requirements — 05 via
        // the word cap AFTER extraction (FR-2.6), 12 via this page count
        // BEFORE it — and a test that distinguished them by error code
        // alone would prove nothing about either.
        details: { limit: "pages", pages: info.total, max: config.MAX_PDF_PAGES },
      });
    }

    const result = await parser.getText();
    return result.text;
  } catch (err) {
    // An AppError here is one of this function's own decisions above, not
    // a parser failure — passing it through is what keeps
    // ENCRYPTED_DOCUMENT and DOCUMENT_TOO_LONG from being flattened into
    // MALFORMED_DOCUMENT by the catch-all below.
    if (err instanceof AppError) throw err;
    // The specific exception is deliberately discarded, not logged: it
    // may quote the PDF's internal structure, and FR-2.7 bars document
    // content from logs. The generic message below is what the user
    // gets; the fact that extraction failed is what monitoring needs.
    throw new AppError("MALFORMED_DOCUMENT");
  } finally {
    // Releases the underlying pdf.js document regardless of outcome —
    // an early return on the success path must not skip this.
    await parser.destroy().catch(() => {});
  }
}
