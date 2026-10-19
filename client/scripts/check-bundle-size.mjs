// FR-7.13 — "Initial JS bundle ≤ 200 KB gzipped ... Enforced in CI by a
// bundle-size check." This is that check, run against an already-built
// dist/ (`npm run build && npm run bundle:check`).
//
// It also asserts the other half of BUILD-PLAN step 29's verification —
// "the built index.html contains no inline script" (FR-7.9) — in the same
// script rather than a second one, because both read the same file: an
// inline <script src="..."> is fine, a bare <script>...</script> with
// content is not, and the file that already has to parse dist/index.html
// for the first check might as well not skip the second.
//
// "Initial" means what a first-time visitor's browser fetches and parses
// before the app can render anything: the module Vite wires up in
// index.html plus every chunk it <link rel="modulepreload">s (Vite marks a
// script's synchronous import graph this way; a route lazy-loaded behind
// React.lazy() is a separate chunk that only downloads on navigation and
// is correctly excluded). "KB" is read as 1024 bytes, the stricter of the
// two common readings, so this errs toward catching a budget overrun
// rather than missing one.

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = join(CLIENT_DIR, "dist");
const BUDGET_BYTES = 200 * 1024;

function readDistIndexHtml() {
  const path = join(DIST_DIR, "index.html");
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (
      err instanceof Error &&
      /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT"
    ) {
      console.error(`${path} does not exist. Run \`npm run build\` first.`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Every <script type="module" src="..."> and <link rel="modulepreload"
 * href="..."> in index.html — Vite's own record of what the initial page
 * load actually fetches. Also collects any <script> with no src (or with
 * inline content) as a CSP violation to report separately.
 *
 * HTML comments are stripped first. This file's own template
 * (client/index.html) explains the no-inline-script rule in a comment
 * that quotes a `<script src="...">` tag as an example — text a regex
 * scanner would otherwise mistake for a real, unclosed tag and pair with
 * whatever the next `</script>` in the file happens to be.
 *
 * @param {string} html
 */
function parseIndexHtml(html) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const initialAssets = [];
  const inlineScripts = [];

  for (const match of withoutComments.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
  )) {
    const [, attrs, body] = match;
    const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
    if (srcMatch) {
      initialAssets.push(srcMatch[1]);
    } else if (body.trim() !== "") {
      inlineScripts.push(body.trim());
    }
    // A src-less, empty <script></script> (there is no legitimate reason
    // for one to exist) is neither an asset nor a CSP violation, so it is
    // deliberately neither collected list's problem.
  }

  for (const match of withoutComments.matchAll(/<link\b([^>]*)>/gi)) {
    const [, attrs] = match;
    if (!/\brel=["']modulepreload["']/i.test(attrs)) continue;
    const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (hrefMatch) initialAssets.push(hrefMatch[1]);
  }

  return { initialAssets, inlineScripts };
}

/** @param {string} assetPath e.g. "/assets/index-abc123.js" */
function gzippedSize(assetPath) {
  // Vite writes index.html referencing assets by absolute URL path
  // ("/assets/..."); dist/ is the site root, so strip the leading slash.
  const onDisk = join(DIST_DIR, assetPath.replace(/^\//, ""));
  const bytes = readFileSync(onDisk);
  return gzipSync(bytes).length;
}

function main() {
  const html = readDistIndexHtml();
  const { initialAssets, inlineScripts } = parseIndexHtml(html);

  if (inlineScripts.length > 0) {
    console.error(
      `FR-7.9: dist/index.html contains ${inlineScripts.length} inline <script> block(s) with ` +
        `content. script-src 'self' with no unsafe-inline allows none:\n`,
    );
    for (const script of inlineScripts) {
      console.error(
        `  ${JSON.stringify(script.slice(0, 120))}${script.length > 120 ? "…" : ""}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  // FR-7.13's other half depends on this (vite.config.js's
  // preloadBodyFont): without the preload, the report's LCP measured over
  // budget. The plugin already fails the build if it cannot find the font;
  // this catches the plugin itself being removed.
  if (
    !/<link rel="preload" href="\/assets\/host-grotesk-latin-wght-normal-[\w-]+\.woff2" as="font"/.test(
      html,
    )
  ) {
    console.error(
      "FR-7.13: dist/index.html does not preload the body font (host-grotesk-latin-wght-normal). " +
        "The LCP budget depends on it; see vite.config.js.",
    );
    process.exitCode = 1;
    return;
  }

  const jsAssets = initialAssets.filter((asset) => asset.endsWith(".js"));
  if (jsAssets.length === 0) {
    console.error("No initial JS assets found in dist/index.html — is the build broken?");
    process.exitCode = 1;
    return;
  }

  let totalBytes = 0;
  const rows = jsAssets.map((asset) => {
    const size = gzippedSize(asset);
    totalBytes += size;
    return { asset, size };
  });

  rows.sort((a, b) => b.size - a.size);
  for (const { asset, size } of rows) {
    console.log(`  ${(size / 1024).toFixed(1).padStart(7)} KB gzipped  ${asset}`);
  }
  console.log(
    `  ${"-".repeat(9)}\n  ${(totalBytes / 1024).toFixed(1).padStart(7)} KB gzipped  total ` +
      `(budget ${(BUDGET_BYTES / 1024).toFixed(0)} KB)`,
  );

  if (totalBytes > BUDGET_BYTES) {
    console.error(
      `\nFR-7.13: initial JS is ${(totalBytes / 1024).toFixed(1)} KB gzipped, over the ` +
        `${(BUDGET_BYTES / 1024).toFixed(0)} KB budget.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    "\nOK: no inline script, body font preloaded, initial JS within the FR-7.13 budget.",
  );
}

main();
