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
 * WEIGHTS are exactly what the stylesheets use, and no more. Literata
 * dropped from five weights to three when it stopped setting headings.
 *
 * SUBSETS: latin for all three, plus latin-ext where the family offers
 * it. One honest gap, stated rather than discovered later: @fontsource's
 * Geist Sans ships a latin subset only, with no latin-ext. Western
 * European accents (é, ñ, ü) live in `latin` and are covered; a Central
 * or Eastern European character (ł, ș, ő) in SANS-rendered text would
 * fall back to system-ui for that glyph. That gap does not touch the
 * text where it would matter — quoted contract excerpts are Literata and
 * filenames are Geist Mono, and both of those carry latin-ext — so what
 * is exposed is UI chrome and an email address, which FR-7.14 already
 * scopes to English.
 */

/* The product's voice. */
import "@fontsource/geist-sans/latin-400.css";
import "@fontsource/geist-sans/latin-500.css";
import "@fontsource/geist-sans/latin-600.css";
import "@fontsource/geist-sans/latin-700.css";

/* The document's voice. */
import "@fontsource/literata/latin-400.css";
import "@fontsource/literata/latin-ext-400.css";
import "@fontsource/literata/latin-400-italic.css";
import "@fontsource/literata/latin-ext-400-italic.css";
import "@fontsource/literata/latin-700.css";
import "@fontsource/literata/latin-ext-700.css";

/* Machine facts. */
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-ext-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "@fontsource/geist-mono/latin-ext-500.css";
