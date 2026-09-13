import { PDFParse } from "pdf-parse";
import { AppError } from "../lib/AppError.js";

/**
 * FR-2.10 — extracts raw text from a PDF buffer. Any parser failure
 * becomes 422 MALFORMED_DOCUMENT; it never reaches the global handler as
 * an unhandled 500. A malformed upload is the user's problem to fix, and
 * reporting it as a server error would both mislabel that and hide real
 * defects in the error-rate metric.
 *
 * pdf-parse@2.x exports named exception classes (InvalidPDFException,
 * PasswordException, ...), but this step deliberately does not branch on
 * them — FR-2.10 as scoped here just wants "a parser exception -> 422,
 * never 500". Distinguishing PasswordException into its own 422
 * ENCRYPTED_DOCUMENT is step 48's job (FR-2.10's other clause, tagged
 * [P1.5]); until then an encrypted PDF lands here and is reported as
 * MALFORMED_DOCUMENT — mislabelled, but never a 500.
 *
 * Returns the RAW extracted text, unnormalised. Normalisation is
 * extraction.js's job (step 15) and callers apply it — this function's
 * only responsibility is turning bytes into a string or a 422.
 */
export async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } catch {
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
