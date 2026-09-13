import JSZip from "jszip";

/**
 * Builds a genuinely extractable DOCX — not just one that types correctly
 * (step 16's local helper in upload.test.js only needs the ZIP entry name
 * and doesn't include _rels/.rels, since it tests type detection, not
 * content). Mammoth needs the relationships part to resolve
 * word/document.xml, so this includes it.
 *
 * @param {{ paragraphs?: string[], compression?: "DEFLATE" | "STORE" }} [options]
 * @returns {Promise<Buffer>}
 */
export async function buildDocx({ paragraphs = ["Hello, this is a test document."], compression = "DEFLATE" } = {}) {
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
  );

  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  );

  const escapeXml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join("");

  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${body}</w:body></w:document>`,
  );

  return zip.generateAsync({ type: "nodebuffer", compression });
}
