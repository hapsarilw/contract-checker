import multer from "multer";
import { AppError } from "../lib/AppError.js";

/**
 * FR-2.1 – FR-2.3, FR-2.14 — upload intake.
 *
 * ─────────────────────────────────────────────────────────────────────
 * INTAKE ERROR PRECEDENCE. Several fixtures depend on which fires first.
 * ─────────────────────────────────────────────────────────────────────
 *
 *   1. Content-Length / 5 MB ......... 413 FILE_TOO_LARGE      (here)
 *   2. Magic bytes ................... 422 UNSUPPORTED_FILE_TYPE (here)
 *   3. Archive and PDF structural limits ... 422 MALFORMED_DOCUMENT /
 *      DOCUMENT_TOO_LONG / ENCRYPTED_DOCUMENT          (step 48)
 *   4. Extraction timeout ............ 422 MALFORMED_DOCUMENT   (step 17)
 *   5. Word-count bounds ............. 422 DOCUMENT_TOO_SHORT /
 *      DOCUMENT_TOO_LONG                                (step 18)
 *
 * The order is cheapest-and-most-certain first. A 6 MB file is rejected
 * on a header, before a byte of it is read; an unsupported type on four
 * bytes, before a parser is handed hostile input. Fixture 08
 * (`08-not-really-a-pdf`, magic bytes `46 52 45 45`) exists precisely to
 * prove step 2 fires before anything downstream tries to parse it, and
 * fixture 06 (a scanned PDF, valid type, no text layer) proves a file
 * can pass steps 1–2 and still fail at step 5.
 */

/** FR-2.2 — 5 MB. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** FR-2.14 — filenames are stored, never used to build a path. */
const MAX_FILENAME_LENGTH = 255;

/**
 * FR-2.2's Content-Length pre-check.
 *
 * Multer's own limit is the second line, not the first. By the time
 * Multer rejects, the bytes have already been streamed into memory —
 * which is exactly what a 5 MB cap exists to prevent, and what makes
 * MAX_CONCURRENT_UPLOADS × 5 MB (§6.1) a bound rather than a hope.
 * Rejecting on the header costs nothing and never buffers.
 *
 * A missing or unparseable Content-Length is NOT rejected here: chunked
 * transfer encoding legitimately omits it. Those requests fall through
 * to Multer's limit, which still stops them — one layer instead of two,
 * which is why both layers exist.
 */
export function rejectOversizeByContentLength(req, res, next) {
  const header = req.headers["content-length"];

  if (header !== undefined) {
    const declared = Number(header);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      next(new AppError("FILE_TOO_LARGE"));
      return;
    }
  }

  next();
}

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    // A multipart body is not a place to send many fields; bounding this
    // keeps a hostile part-count from becoming parser work.
    fields: 5,
  },
});

/**
 * Translates Multer's own errors into the API's error vocabulary.
 * Without this a 6 MB upload that slips past the header check surfaces
 * as 500 INTERNAL — technically an unhandled error, practically a lie
 * about whose fault it is.
 */
function toAppError(err) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return new AppError("FILE_TOO_LARGE");
    // Every other Multer limit is a malformed request rather than a
    // too-large one: too many files, an unexpected field name, a
    // field-name nesting depth no real client produces.
    return new AppError("VALIDATION_ERROR", { details: { multerCode: err.code } });
  }
  return err;
}

/** Accepts exactly one file, on the field name §4 specifies: `file`. */
export function singleFileUpload(req, res, next) {
  memoryUpload.single("file")(req, res, (err) => {
    next(err ? toAppError(err) : undefined);
  });
}

/**
 * FR-2.3 — type comes from MAGIC BYTES ONLY.
 *
 * Never the extension, never `file.mimetype`. Multer populates
 * `mimetype` from the multipart part's own Content-Type header, which
 * is supplied by the client and therefore means nothing: renaming
 * `contract.txt` to `contract.pdf` and declaring `application/pdf` is a
 * two-second operation, and fixture 08 does exactly that.
 */
const PDF_MAGIC = Buffer.from("%PDF", "ascii");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

/**
 * A DOCX is a ZIP, but so is every other OOXML file, every JAR, and
 * every ODT. FR-2.3 requires "a DOCX content-type check" on top of the
 * ZIP signature — something that distinguishes WordprocessingML from
 * every other ZIP.
 *
 * This reads the archive's FIRST LOCAL FILE HEADER and checks the entry
 * NAME, which is `[Content_Types].xml` in every OOXML package. It does
 * not unzip: a real inflate on untrusted input is the archive-bomb
 * surface step 48 hardens, and running it here would take that risk
 * before the limits meant to contain it exist.
 *
 * Why the name and not the content type string inside that entry —
 * measured, not assumed. A DOCX writer deflates `[Content_Types].xml`
 * when it is large enough to be worth compressing, and the
 * WordprocessingML string then survives nowhere in the raw bytes. A scan
 * for it reports "not a DOCX" for exactly the files most likely to be
 * real ones. The ZIP local file header stores the entry name as literal
 * bytes regardless of compression method, so it is readable either way.
 *
 * The cost of this choice, stated plainly: `[Content_Types].xml` is
 * common to all OOXML, so a .xlsx or .pptx passes this check and is
 * rejected later by the DOCX parser (step 17) rather than here. That is
 * the right trade — a type check that wrongly rejects real .docx files
 * is a worse failure than one that lets a spreadsheet reach a parser
 * that will refuse it.
 *
 * ZIP local file header layout (offsets from the PK\x03\x04 signature):
 *   0  signature (4)          26  file-name length   (2, LE)
 *   8  compression method (2) 28  extra-field length (2, LE)
 *                             30  file name (file-name length bytes)
 */
const OOXML_FIRST_ENTRY = Buffer.from("[Content_Types].xml", "ascii");

/** Offsets into the ZIP local file header. */
const ZIP_NAME_LENGTH_OFFSET = 26;
const ZIP_NAME_OFFSET = 30;

/**
 * @param {Buffer} buffer
 * @returns {"UPLOAD_PDF" | "UPLOAD_DOCX" | null} the SourceType, or null
 *   if the bytes are neither.
 */
export function detectSourceType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

  if (buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return "UPLOAD_PDF";
  }

  if (buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    // Truncated headers are rejected rather than read past: a buffer
    // that claims a name longer than itself is malformed, not a DOCX.
    if (buffer.length < ZIP_NAME_OFFSET) return null;

    const nameLength = buffer.readUInt16LE(ZIP_NAME_LENGTH_OFFSET);
    if (nameLength !== OOXML_FIRST_ENTRY.length) return null;
    if (buffer.length < ZIP_NAME_OFFSET + nameLength) return null;

    const entryName = buffer.subarray(ZIP_NAME_OFFSET, ZIP_NAME_OFFSET + nameLength);
    if (entryName.equals(OOXML_FIRST_ENTRY)) {
      return "UPLOAD_DOCX";
    }
  }

  return null;
}

/**
 * FR-2.14 — stored, never used to build a filesystem path.
 *
 * Path separators are stripped rather than escaped, and the result is
 * never joined to a directory anywhere in this codebase: the defence is
 * that no filesystem path is ever constructed from user input at all,
 * not that this function is clever enough to make one safe. Stripping
 * them is belt-and-braces for the day someone forgets that.
 *
 * Control characters go for the same reason they go in normalize():
 * they are invisible where the filename is displayed. Rendering is
 * React's default escaping (FR-7.8), already enforced by the
 * `dangerouslySetInnerHTML` lint ban from step 2 — this is the storage
 * half of that requirement.
 */
export function sanitizeFilename(filename) {
  if (typeof filename !== "string") return null;

  const cleaned = filename
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[ --]/g, "")
    .replace(/[/\\]/g, "")
    .trim();

  if (cleaned === "") return null;

  return cleaned.slice(0, MAX_FILENAME_LENGTH);
}
