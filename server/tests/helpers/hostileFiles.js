import JSZip from "jszip";
import PDFDocument from "pdfkit";

/**
 * Hostile inputs for TR-18, GENERATED AT TEST TIME rather than committed.
 * Step 72 gives the reason: the repository runs secret and dependency
 * scanning and may become public, and scanners — and some git hosts —
 * will flag or outright refuse a committed zip bomb.
 */

/**
 * A DOCX whose entries expand far beyond what the file itself weighs.
 * Zeros because they compress to almost nothing, which is what makes the
 * ratio extreme without needing a large upload.
 *
 * @param {{ megabytes?: number, entries?: number }} [options]
 */
export async function buildZipBomb({ megabytes = 10, entries = 1 } = {}) {
  const zip = new JSZip();
  const payload = Buffer.alloc(Math.round((megabytes * 1024 * 1024) / entries));
  // Named so magic-byte detection still types it as a DOCX: the point is
  // to reach the archive checks, not to be rejected as the wrong type.
  zip.file("[Content_Types].xml", "<Types/>");
  for (let index = 0; index < entries; index += 1) {
    zip.file(`word/bomb-${index}.bin`, payload);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** A DOCX with more members than FR-2.9 allows, each one trivial. */
export async function buildManyEntryDocx(count) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  for (let index = 0; index < count; index += 1) zip.file(`word/e${index}.xml`, "<a/>");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * Rewrites every central-directory record's `uncompressed size` field to a
 * small number, so the archive DECLARES almost nothing while still
 * expanding enormously.
 *
 * This is the whole reason FR-2.9 has a second check: the declared sizes
 * are written by whoever built the file, and a hostile one simply lies.
 * A test that only used an honest bomb would pass against an
 * implementation that trusted the header.
 *
 * @param {Buffer} buffer
 * @param {number} [declared]
 */
export function lieAboutUncompressedSizes(buffer, declared = 1024) {
  const patched = Buffer.from(buffer);
  const CENTRAL_SIGNATURE = 0x02014b50;
  for (let at = 0; at + 46 <= patched.length; at += 1) {
    if (patched.readUInt32LE(at) !== CENTRAL_SIGNATURE) continue;
    patched.writeUInt32LE(declared, at + 24);
  }
  return patched;
}

/**
 * @param {{ pages?: number, password?: string, text?: string }} [options]
 * @returns {Promise<Buffer>}
 */
export function buildPdf({ pages = 1, password, text = "CONSULTING AGREEMENT" } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument(
      password ? { userPassword: password, ownerPassword: password } : {},
    );
    /** @type {Buffer[]} */
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.text(text);
    for (let page = 1; page < pages; page += 1) {
      doc.addPage().text(`${text} — page ${page + 1}`);
    }
    doc.end();
  });
}

/** A PDF that starts correctly and then stops mid-structure. */
export async function buildTruncatedPdf() {
  const whole = await buildPdf({ pages: 3 });
  return whole.subarray(0, Math.floor(whole.length / 2));
}
