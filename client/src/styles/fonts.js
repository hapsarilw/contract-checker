/**
 * Self-hosted via @fontsource rather than a Google Fonts <link>, on
 * purpose: FR-7.9's Content Security Policy gives no style-src/font-src
 * exception for fonts.googleapis.com/fonts.gstatic.com (only script-src,
 * connect-src and img-src get explicit third-party carve-outs, and
 * PRD D11 bars third-party origins from any report-rendering route
 * regardless). Self-hosting also means this confidential-document
 * product never has a browser make a font request to Google on every
 * page load. @fontsource ships the woff2 files as package assets, so
 * Vite serves them from the app's own origin like any other static
 * asset — default-src 'self' already covers them.
 *
 * THREE FAMILIES, THREE JOBS, and the split is the point of the type
 * system rather than an inherited accident:
 *
 *   Geist Sans  — the product's voice. Every heading, label, control and
 *                 paragraph the APP writes. Replaced Source Sans 3, and
 *                 also took over display duty from Literata: when the
 *                 interface set its own headings in a book serif, the
 *                 tool sounded like the document it was supposed to be
 *                 examining.
 *   Literata    — the DOCUMENT's voice, and nothing else. Verbatim
 *                 contract excerpts, and the one risk word those
 *                 excerpts add up to. Kept (not dropped) because that
 *                 distinction is worth a whole typeface: serif on screen
 *                 here means "these are the contract's words, not ours".
 *   Geist Mono  — machine facts. Filenames, word counts, dates.
 *                 Replaced Source Code Pro, so the mono and the sans are
 *                 now siblings with matching proportions instead of two
 *                 unrelated designs.
 *
 * VARIABLE FONTS, ONE FILE PER FAMILY (BUILD-PLAN step 66). This used to
 * import each weight as its own static file: four for Geist Sans, two
 * for Geist Mono, three for Literata, each with a latin-ext twin. The
 * report downloaded twelve font files, about 290 KB, and on FR-7.13's
 * simulated mid-tier phone over slow 4G those bytes competed with the
 * app's own JavaScript and held Largest Contentful Paint to 3.15 s on
 * the report and 2.7 s on upload, against a 2.5 s budget. Measured, not
 * guessed: the same build with no web fonts at all painted at 1.65 s on
 * every page, so the fonts were the whole overrun. A variable font carries
 * every weight in one file: Geist's latin file is 29 KB for weights
 * 100-900, where the four static weights were 138 KB between them.
 *
 * Every weight the stylesheets ask for (400, 500, 600, 700) is now an
 * exact instance of the variable axis rather than a separate download,
 * so a new weight costs nothing and cannot silently add a request.
 *
 * `wght.css` declares every subset with its unicode-range; the browser
 * downloads only the subsets whose characters are on the page, which for
 * English copy is `latin` alone.
 *
 * SUBSETS: the variable Geist ships latin-ext, which the static Geist Sans
 * never did, so the gap this comment used to record (a Central European
 * character in sans text falling back to system-ui for that glyph) is
 * closed.
 *
 * NO ITALIC: nothing in the stylesheets or the markup sets italic, so no
 * italic face is imported. If one is ever needed, it is one more import
 * of `wght-italic.css`, not a synthesized slant.
 *
 * Family names are the variable packages' own ("Geist Variable" and so
 * on); tokens.css names them.
 */

/* The product's voice. */
import "@fontsource-variable/geist/wght.css";

/* The document's voice. */
import "@fontsource-variable/literata/wght.css";

/* Machine facts. */
import "@fontsource-variable/geist-mono/wght.css";
