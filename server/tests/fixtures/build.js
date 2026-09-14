// SRS §11.3 — the fixture document generator.
//
// contracts.js defines each flagged clause exactly once, in a body array of
// ['h', text] / ['p', text] tuples shared by every format a fixture ships in.
// This script walks that array into a .docx via the `docx` package (a pure
// JS library, unlike the `soffice --headless` process the old README
// described — not reproducible, and not installed in CI), then derives the
// .txt fixture by running mammoth over the .docx THIS SCRIPT JUST BUILT,
// using the exact extractor production uses (src/services/docx.js).
//
// That ordering is the point: the .txt file is not a second, independent
// rendering of the body array that could drift from the .docx — it is that
// .docx, read back through our own pipeline. A DOCX/PDF vs .txt mismatch is
// then provably an extraction defect (FR-2.4), never a difference between
// documents, because there is only one document.
//
// Typographic apostrophes in contracts.js (§11.3, to exercise §5.3's
// curly-quote branch) are never touched here — every string passes through
// unmodified from body array to .docx run to mammoth's output.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import mammoth from "mammoth";
import { contracts } from "./contracts.js";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * @param {{ title: string, body: [string, string][] }} contract
 * @returns {Promise<Buffer>}
 */
function buildDocxBuffer({ title, body }) {
  const paragraphs = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    ...body.map(([kind, text]) =>
      kind === "h"
        ? new Paragraph({ text, heading: HeadingLevel.HEADING_1 })
        : new Paragraph({ text }),
    ),
  ];
  return Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }));
}

/**
 * @param {string} slug
 * @param {{ title: string, body: [string, string][] }} contract
 */
async function buildFixture(slug, contract) {
  const docxBuffer = await buildDocxBuffer(contract);

  const { value: text, messages } = await mammoth.extractRawText({ buffer: docxBuffer });
  if (messages.length > 0) {
    // A formatting-fidelity warning here means mammoth read something back
    // from our own generated .docx that it didn't fully understand — worth
    // looking at before trusting the fixture, not something to ignore the
    // way production silently discards these (src/services/docx.js's docstring
    // explains why production can: a user's document isn't answer-keyed, a
    // fixture's excerpts are).
    throw new Error(
      `${slug}: mammoth reported ${messages.length} formatting message(s) reading back the generated .docx: ` +
        messages.map((m) => m.message).join("; "),
    );
  }

  writeFileSync(join(FIXTURES_DIR, `${slug}.docx`), docxBuffer);
  writeFileSync(join(FIXTURES_DIR, `${slug}.txt`), text, "utf8");

  return { slug, words: text.trim().split(/\s+/).filter(Boolean).length };
}

async function main() {
  const withSourceText = Object.entries(contracts).filter(([, contract]) => contract.body);
  if (withSourceText.length === 0) {
    throw new Error("no fixture in contracts.js has a body — nothing to build");
  }

  for (const [slug, contract] of withSourceText) {
    const { words } = await buildFixture(slug, contract);
    console.log(`${slug}: wrote .docx and .txt (${words} words)`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
