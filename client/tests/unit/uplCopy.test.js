import { readFileSync, readdirSync, statSync } from "node:fs";
import process from "node:process";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * PRD §12.2, the unauthorized-practice-of-law boundary, as a test
 * (BUILD-PLAN step 74): "Marketing copy is subject to the same rule as
 * product copy: no 'legal review,' no 'lawyer-approved,' no 'protects
 * you.'" Every string a user can read is checked: the client's string
 * literals and JSX text (never its comments, which discuss the rule and
 * would trip it), the server's email templates, the legal pages, the
 * README and SECURITY.md, and the design prototype's copy.
 *
 * Two kinds of rule:
 *   BANNED   phrases that claim the product is, or is vouched for by, a
 *            lawyer, or that promise an outcome. Never allowed.
 *   NEGATED  "legal advice" and "safe to sign" are fine only where the
 *            text says the opposite ("this isn't legal advice"). A short
 *            allowlist names the two places where the negation is a
 *            heading rather than the same sentence, each with its reason.
 */

const ROOT = join(process.cwd(), "..");

const BANNED = [
  /legal review/i,
  /lawyer[- ]?(approved|reviewed|vetted|checked|grade)/i,
  /attorney[- ]?(approved|reviewed|vetted)/i,
  /\bprotects? you\b/i,
  /\b(we|clausecheck) guarantees?\b/i,
  /\bguaranteed (safe|protection|outcome)/i,
  /\byour (lawyer|attorney)\b(?! )|\bact as your (lawyer|attorney)/i,
];

const NEGATED = [/legal advice/gi, /safe to sign/gi];
const NEGATION =
  /\b(not|no|never|isn['’]t|aren['’]t|doesn['’]t|does not|substitute for|instead of)\b/i;

/** Where the negation is the heading above, not the sentence itself. */
const ALLOWED = [
  {
    file: "client/src/pages/UploadPage.jsx",
    text: "Legal advice. It is a first pass",
    why: "the answer under the heading 'What this is not'",
  },
  {
    file: "docs/design/ClauseCheck.html",
    text: "Legal advice. It's a first pass",
    why: "the prototype of the same 'What this is not' item",
  },
];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * The text a user can read in a JS/JSX file: string and template
 * literals, and JSX text. Not comments, not identifiers.
 * @param {string} path
 */
function userText(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX,
  );
  /** @type {string[]} */
  const out = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      out.push(node.text);
    else if (ts.isTemplateExpression(node))
      out.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
    else if (ts.isJsxText(node)) out.push(node.text.replace(/\s+/g, " "));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out.join("\n");
}

/** Every user-readable corpus, as [file, text]. */
function corpus() {
  /** @type {[string, string][]} */
  const files = [];
  for (const path of walk(join(ROOT, "client", "src")).filter((p) =>
    /\.(js|jsx)$/.test(p),
  )) {
    files.push([relative(ROOT, path), userText(path)]);
  }
  files.push([
    "server/src/lib/email/templates.js",
    userText(join(ROOT, "server", "src", "lib", "email", "templates.js")),
  ]);
  for (const doc of ["README.md", "SECURITY.md"])
    files.push([doc, readFileSync(join(ROOT, doc), "utf8")]);
  // The prototype ships its copy inside an escaped bundle: an apostrophe is
  // a backslash-u escape, a quote a backslashed quote. Decoded to what its
  // page renders, or "isn't legal advice" would not read as the denial it is.
  const BACKSLASH = String.fromCharCode(92);
  const prototype = readFileSync(join(ROOT, "docs", "design", "ClauseCheck.html"), "utf8")
    .replace(new RegExp(`${BACKSLASH}${BACKSLASH}+u([0-9a-fA-F]{4})`, "g"), (_m, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(new RegExp(`${BACKSLASH}${BACKSLASH}+(['"])`, "g"), "$1");
  files.push(["docs/design/ClauseCheck.html", prototype]);
  return files;
}

describe("PRD §12.2: no string claims, or borrows, a lawyer's authority", () => {
  const files = corpus();

  it("reads something from every corpus (a scanner that reads nothing passes everything)", () => {
    const client = files.filter(([f]) => f.startsWith("client/src"));
    expect(client.length).toBeGreaterThan(40);
    expect(client.reduce((n, [, text]) => n + text.length, 0)).toBeGreaterThan(20_000);
    for (const [file, text] of files.filter(([f]) => !f.startsWith("client/src"))) {
      expect(text.length, file).toBeGreaterThan(500);
    }
    // The copy that matters most is really in the corpus.
    expect(files.find(([f]) => f.endsWith("legal/content.js"))?.[1]).toMatch(
      /attorney-client relationship/,
    );
    expect(files.find(([f]) => f.endsWith("UploadPage.jsx"))?.[1]).toMatch(
      /Legal advice\. It is a first pass/,
    );
  });

  it.each(BANNED.map((re) => [String(re), re]))("never says %s", (_name, re) => {
    const hits = files
      .filter(([, text]) => re.test(text))
      .map(([file, text]) => `${file}: …${text.match(re)?.[0]}…`);
    expect(hits).toEqual([]);
  });

  it("says 'legal advice' and 'safe to sign' only to deny them", () => {
    /** @type {string[]} */
    const bad = [];
    for (const [file, text] of files) {
      for (const re of NEGATED) {
        for (const m of text.matchAll(re)) {
          const before = text.slice(Math.max(0, (m.index ?? 0) - 60), m.index);
          const at = text.slice(m.index, (m.index ?? 0) + 40);
          if (NEGATION.test(before)) continue;
          if (
            ALLOWED.some(
              (a) =>
                a.file === file &&
                at.startsWith(a.text.slice(0, 13)) &&
                text.includes(a.text),
            )
          )
            continue;
          bad.push(
            `${file}: …${text.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 40)}…`,
          );
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("every allowlist entry still matches something, so none outlives its reason", () => {
    for (const a of ALLOWED) {
      const text = files.find(([file]) => file === a.file)?.[1] ?? "";
      expect(text.includes(a.text), `${a.file}: ${a.why}`).toBe(true);
    }
  });
});
