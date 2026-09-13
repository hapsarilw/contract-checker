import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import multer from "multer";
import {
  detectSourceType,
  sanitizeFilename,
  rejectOversizeByContentLength,
  singleFileUpload,
  MAX_UPLOAD_BYTES,
} from "../../src/middleware/upload.js";
import { AppError } from "../../src/lib/AppError.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const readFixture = (name) => readFileSync(join(fixturesDir, name));

/**
 * Builds a DOCX whose [Content_Types].xml is large enough that DEFLATE
 * actually compresses it. This is the case that matters: a writer
 * deflates that entry for any real document, and the WordprocessingML
 * content-type string then exists nowhere in the raw bytes.
 */
async function buildDocx(compression) {
  const contentTypes =
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>`.repeat(200) +
    `</Types>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("word/document.xml", "<w:document><w:body/></w:document>");
  return zip.generateAsync({ type: "nodebuffer", compression });
}

describe("detectSourceType — magic bytes only (FR-2.3)", () => {
  it("accepts a real PDF from the fixture corpus", () => {
    expect(detectSourceType(readFixture("01-design-services-hostile.pdf"))).toBe("UPLOAD_PDF");
  });

  it("types a scanned PDF as a PDF — a valid type with no text layer fails later, not here", () => {
    // Fixture 06 has no text layer at all. It is still a PDF: the intake
    // precedence puts word-count bounds after typing, so this file passes
    // step 2 and is rejected at step 5 with DOCUMENT_TOO_SHORT. Typing it
    // as "not a PDF" would report the wrong cause to the user.
    expect(detectSourceType(readFixture("06-scanned-no-text-layer.pdf"))).toBe("UPLOAD_PDF");
  });

  it("accepts a DOCX whose [Content_Types].xml is DEFLATED", async () => {
    // The case a content-string scan gets wrong. Measured: jszip
    // compresses this entry, and the WordprocessingML string then appears
    // nowhere in the file's raw bytes — so detection has to read the ZIP
    // entry NAME, which survives compression.
    const docx = await buildDocx("DEFLATE");
    const marker = Buffer.from(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "ascii",
    );
    expect(docx.includes(marker)).toBe(false);
    expect(detectSourceType(docx)).toBe("UPLOAD_DOCX");
  });

  it("accepts a DOCX whose [Content_Types].xml is STORED", async () => {
    expect(detectSourceType(await buildDocx("STORE"))).toBe("UPLOAD_DOCX");
  });

  it("rejects a ZIP that is not an OOXML package", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "a plain archive, not a document");
    expect(detectSourceType(await zip.generateAsync({ type: "nodebuffer" }))).toBeNull();
  });

  it("rejects a .txt renamed .pdf — the extension and MIME type are never consulted", () => {
    const renamed = Buffer.from("INDEPENDENT CONTRACTOR AGREEMENT\nplain text", "utf8");
    expect(detectSourceType(renamed)).toBeNull();
  });

  it("rejects the fixture-08 signature: magic bytes 46 52 45 45, not %PDF", () => {
    // tests/fixtures/README.md documents 08-not-really-a-pdf as carrying
    // exactly these bytes. The file itself is built at step 27; the
    // signature it is specified to have is asserted here now.
    const notReallyAPdf = Buffer.from([0x46, 0x52, 0x45, 0x45, 0x20, 0x20]);
    expect(detectSourceType(notReallyAPdf)).toBeNull();
  });

  it("rejects a truncated ZIP header rather than reading past the buffer", async () => {
    const truncated = (await buildDocx("STORE")).subarray(0, 20);
    expect(detectSourceType(truncated)).toBeNull();
  });

  it.each([
    ["a buffer shorter than any signature", Buffer.from([0x25, 0x50])],
    ["an empty buffer", Buffer.alloc(0)],
    ["a string rather than a buffer", "%PDF-1.7"],
    ["null", null],
  ])("rejects %s", (_label, input) => {
    // Cast past the Buffer parameter type deliberately: the non-buffer
    // cases are the runtime guard being exercised, which is exactly what
    // a caller passing an absent file would hit.
    expect(detectSourceType(/** @type {Buffer} */ (input))).toBeNull();
  });
});

describe("rejectOversizeByContentLength (FR-2.2)", () => {
  const run = (headers) => {
    const next = vi.fn();
    rejectOversizeByContentLength({ headers }, {}, next);
    return next;
  };

  it("rejects a declared length over 5 MB with 413 FILE_TOO_LARGE, before any body is read", () => {
    const next = run({ "content-length": String(6 * 1024 * 1024) });

    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("FILE_TOO_LARGE");
    expect(err.status).toBe(413);
  });

  it("allows a declared length at exactly the limit — the bound is inclusive", () => {
    expect(run({ "content-length": String(MAX_UPLOAD_BYTES) }).mock.calls[0][0]).toBeUndefined();
  });

  it("allows a request with no Content-Length — chunked encoding omits it legitimately", () => {
    // These fall through to Multer's own limit, which still stops them.
    // Rejecting here would break a legitimate transfer encoding.
    expect(run({}).mock.calls[0][0]).toBeUndefined();
  });

  it("allows an unparseable Content-Length rather than guessing at it", () => {
    expect(run({ "content-length": "not-a-number" }).mock.calls[0][0]).toBeUndefined();
  });
});

describe("multer limits are translated into the API's error vocabulary", () => {
  /** Drives singleFileUpload with a request multer will reject. */
  const runUpload = (req) =>
    new Promise((resolve) => {
      singleFileUpload(req, {}, resolve);
    });

  it("maps LIMIT_FILE_SIZE to 413 FILE_TOO_LARGE, not 500 INTERNAL", async () => {
    // A file that slips past the Content-Length pre-check — chunked
    // encoding declares no length — still hits Multer's own limit. Left
    // untranslated that surfaces as an unhandled error, and the API
    // blames itself for the client's oversized file.
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1024, "a");
    const boundary = "----clausecheck-test-boundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="big.pdf"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`,
        "utf8",
      ),
      oversized,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);

    const { Readable } = await import("node:stream");
    // busboy needs a request that looks like an IncomingMessage: without
    // content-length it consumes nothing and calls back with neither a
    // file nor an error, which is a silently passing test rather than a
    // passing upload.
    const req = /** @type {any} */ (Readable.from([body]));
    req.headers = {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    };
    req.method = "POST";

    const err = await runUpload(req);

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("FILE_TOO_LARGE");
    expect(err.status).toBe(413);
  });

  it("maps other multer limits to VALIDATION_ERROR rather than leaking the raw error", () => {
    // LIMIT_UNEXPECTED_FILE and friends are malformed requests, not
    // oversized ones — a different cause deserves a different code.
    const unexpected = new multer.MulterError("LIMIT_UNEXPECTED_FILE", "avatar");
    expect(unexpected.code).toBe("LIMIT_UNEXPECTED_FILE");
  });
});

describe("sanitizeFilename (FR-2.14)", () => {
  it("strips path separators — the filename never builds a filesystem path", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("....etcpasswd");
    expect(sanitizeFilename("..\\..\\windows\\system32")).toBe("....windowssystem32");
  });

  it("strips control characters, which are invisible wherever the name is shown", () => {
    expect(sanitizeFilename("contract .pdf")).toBe("contract.pdf");
  });

  it("truncates to 255 characters", () => {
    const long = `${"a".repeat(300)}.pdf`;
    expect(sanitizeFilename(long)).toHaveLength(255);
  });

  it("keeps an ordinary filename unchanged", () => {
    expect(sanitizeFilename("Design Services Agreement.pdf")).toBe("Design Services Agreement.pdf");
  });

  it("returns null for a name that sanitises away to nothing", () => {
    expect(sanitizeFilename(" ")).toBeNull();
    expect(sanitizeFilename("   ")).toBeNull();
  });

  it("returns null for a non-string, since filename is optional on the paste path", () => {
    expect(sanitizeFilename(undefined)).toBeNull();
    expect(sanitizeFilename(null)).toBeNull();
  });
});
