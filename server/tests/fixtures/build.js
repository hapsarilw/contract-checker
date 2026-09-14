// SRS §11.3 — the fixture generator.
//
// contracts.js defines each flagged clause exactly once, in a body array of
// ['h', text] / ['p', text] tuples. From that one array this script builds:
//
//   .docx  via the `docx` package, a pure JS library. The `soffice --headless`
//          process this corpus used to rely on is not reproducible and is not
//          installed in CI.
//   .txt   by reading the .docx just built back through mammoth, the extractor
//          production uses (src/services/docx.js). The .txt file is that
//          reading, not a second rendering of the body array.
//   .pdf   via `pdfkit`, from the same body array, then checked: its text,
//          read back with pdf-parse, must hold the same characters in the same
//          order as the .docx's, or the build fails.
//
// So a DOCX/PDF vs .txt mismatch in an extraction test is an extraction
// defect (FR-2.4), never a difference between documents. Every .docx and .pdf
// must also be recognised by production's type detection, or the build fails:
// a fixture that intake rejects before extraction tests nothing it claims to.
//
// Every generated file is pinned to FIXED_DATE instead of the build time, so
// rebuilding unchanged sources rewrites byte-identical files and git stays
// clean.
//
// Typographic apostrophes in contracts.js (§11.3, to exercise §5.3's
// curly-quote branch) pass through untouched into every format.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import mammoth from "mammoth";
import PDFDocument from "pdfkit";
import { PDFParse } from "pdf-parse";
import { detectSourceType } from "../../src/middleware/upload.js";
import { countWords, normalize } from "../../src/services/extraction.js";
import { deriveOverallRisk } from "../../src/services/risk.js";
import { normalizeForMatch } from "../../src/services/verify.js";
import { contracts, plainFixtures, stressReport } from "./contracts.js";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const FIXED_DATE = new Date("2026-01-01T00:00:00Z");
const CONTENT_TYPES = "[Content_Types].xml";

/**
 * @param {{ title: string, body: [string, string][] }} contract
 * @returns {Promise<Buffer>}
 */
async function buildDocx({ title, body }) {
  const packed = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
            ...body.map(([kind, text]) =>
              kind === "h"
                ? new Paragraph({ text, heading: HeadingLevel.HEADING_1 })
                : new Paragraph({ text }),
            ),
          ],
        },
      ],
    }),
  );

  // The package is rewritten entry by entry, for two reasons. docx stamps the
  // build time into docProps/core.xml and into every zip entry, so both are
  // pinned. And docx writes [Content_Types].xml last, while Word writes it
  // first and production's type detection reads only the first entry
  // (src/middleware/upload.js), so it is moved to the front. Directory
  // entries are dropped: zip readers do not need them, and JSZip would stamp
  // implicit ones with the current time.
  const source = await JSZip.loadAsync(packed);
  const names = Object.keys(source.files).filter((name) => !source.files[name].dir);
  if (!names.includes(CONTENT_TYPES)) throw new Error(`docx output has no ${CONTENT_TYPES}`);

  const ordered = new JSZip();
  for (const name of [CONTENT_TYPES, ...names.filter((name) => name !== CONTENT_TYPES)]) {
    const entry = source.files[name];
    const data =
      name === "docProps/core.xml"
        ? (await entry.async("string")).replace(
            /(<dcterms:(?:created|modified)[^>]*>)[^<]*/g,
            `$1${FIXED_DATE.toISOString()}`,
          )
        : await entry.async("uint8array");
    ordered.file(name, data, { date: FIXED_DATE, createFolders: false });
  }
  return ordered.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX" });
}

/**
 * @param {{ title: string, body: [string, string][] }} contract
 * @returns {Promise<Buffer>}
 */
function buildPdf({ title, body }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 72,
      info: { Title: title, CreationDate: FIXED_DATE },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(14).text(title).moveDown(0.8);
    for (const [kind, text] of body) {
      if (kind === "h") {
        doc.font("Helvetica-Bold").fontSize(11).text(text).moveDown(0.3);
      } else {
        doc.font("Helvetica").fontSize(11).text(text, { align: "left" }).moveDown(0.6);
      }
    }
    doc.end();
  });
}

/**
 * The PDF's text without pdf-parse's page markers: this checks that the PDF
 * carries the same document as the .docx, not how the production extractor
 * decorates page boundaries.
 *
 * @param {Buffer} buffer
 */
async function readPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    return (await parser.getText({ pageJoiner: "\n" })).text;
  } finally {
    await parser.destroy();
  }
}

/** @param {string} a @param {string} b */
function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 40))} vs ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 40))}`;
}

/**
 * @param {string} slug
 * @param {{ title: string, body: [string, string][] }} contract
 */
async function buildContract(slug, contract) {
  const docx = await buildDocx(contract);
  if (detectSourceType(docx) !== "UPLOAD_DOCX") {
    throw new Error(`${slug}: production type detection does not recognise the .docx`);
  }

  const { value: text, messages } = await mammoth.extractRawText({ buffer: docx });
  if (messages.length > 0) {
    // Production discards these (src/services/docx.js), but a fixture's
    // excerpts are answer-keyed: anything mammoth did not fully understand
    // in our own output is worth stopping for.
    throw new Error(
      `${slug}: mammoth reported ${messages.length} formatting message(s) reading back the .docx: ` +
        messages.map((message) => message.message).join("; "),
    );
  }

  const pdf = await buildPdf(contract);
  if (detectSourceType(pdf) !== "UPLOAD_PDF") {
    throw new Error(`${slug}: production type detection does not recognise the .pdf`);
  }

  // Compared as the same characters in the same order, whitespace removed.
  // Wrapping a line after a hyphen turns "pre-existing" into "pre-\nexisting"
  // in the PDF's text, which is how the page is laid out, not a different
  // document; a dropped or mis-encoded character is still caught. Whether
  // wrapping breaks an answer-key excerpt is left visible on purpose: that is
  // what checking excerpts against the production extractor is for.
  const characters = (value) => normalizeForMatch(value).replace(/\s+/g, "");
  const fromPdf = characters(await readPdfText(pdf));
  const fromDocx = characters(text);
  if (fromPdf !== fromDocx) {
    throw new Error(`${slug}: the PDF's text differs from the .docx's ${firstDifference(fromPdf, fromDocx)}`);
  }

  writeFileSync(join(FIXTURES_DIR, `${slug}.docx`), docx);
  writeFileSync(join(FIXTURES_DIR, `${slug}.txt`), text, "utf8");
  writeFileSync(join(FIXTURES_DIR, `${slug}.pdf`), pdf);
  console.log(`${slug}: .docx .txt .pdf (${countWords(normalize(text))} words)`);
}

function writePlainFixtures() {
  for (const [name, { ext, content }] of Object.entries(plainFixtures)) {
    writeFileSync(join(FIXTURES_DIR, `${name}.${ext}`), content, "utf8");
    console.log(`${name}: .${ext}`);
  }

  const notAPdf = readFileSync(join(FIXTURES_DIR, "08-not-really-a-pdf.pdf"));
  if (notAPdf.subarray(0, 4).toString("hex") !== "46524545" || detectSourceType(notAPdf) !== null) {
    throw new Error("08-not-really-a-pdf.pdf must start with 46 52 45 45 and be rejected by type detection");
  }
}

function checkScannedFixture() {
  // A rasterised scan with no text layer: it cannot be generated from text,
  // so it is committed as-is and only checked for here.
  if (!existsSync(join(FIXTURES_DIR, "06-scanned-no-text-layer.pdf"))) {
    throw new Error("06-scanned-no-text-layer.pdf is missing and cannot be regenerated");
  }
  console.log("06-scanned-no-text-layer: .pdf present (not generated)");
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * Fixture 13 in the shape GET /api/v1/documents/:id returns (§4.3), with
 * findings in the order the API sends them (§2.2 step 12) and the risk the
 * server rule derives (FR-3.9).
 */
function writeStressReport() {
  const findings = [...stressReport.findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const report = {
    note: "Long-report UI fixture (12 findings), ported from docs/design/ClauseCheck.html FIX.stress and renumbered from 09 to 13 per BUILD-PLAN decision D-E. Generated by build.js from contracts.js; do not edit by hand.",
    document: {
      id: stressReport.documentId,
      filename: "13-stress-long-report.pdf",
      sourceType: "UPLOAD_PDF",
      wordCount: stressReport.wordCount,
      createdAt: stressReport.createdAt,
    },
    analysis: {
      id: stressReport.analysisId,
      status: "COMPLETED",
      overallRisk: deriveOverallRisk(findings),
      summary: stressReport.summary,
      findings: findings.map((finding) => ({
        category: finding.category.toUpperCase(),
        severity: finding.severity.toUpperCase(),
        clauseExcerpt: finding.excerpt,
        explanation: finding.explanation,
        suggestedChange: finding.suggestedChange,
      })),
      missingClauses: stressReport.missingClauses,
      discardedFindings: stressReport.discardedFindings,
      createdAt: stressReport.createdAt,
    },
  };
  writeFileSync(join(FIXTURES_DIR, "13-stress-long-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`13-stress-long-report: .json (${findings.length} findings)`);
}

async function main() {
  for (const [slug, contract] of Object.entries(contracts)) {
    await buildContract(slug, contract);
  }
  checkScannedFixture();
  writePlainFixtures();
  writeStressReport();
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
