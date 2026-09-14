/**
 * BUILD-PLAN step 29, bullet 2 — "Load Literata and Source Sans 3 with
 * real fallback stacks." Self-hosted via @fontsource rather than a Google
 * Fonts <link>, on purpose: FR-7.9's Content Security Policy gives no
 * style-src/font-src exception for fonts.googleapis.com/fonts.gstatic.com
 * (only script-src, connect-src, and img-src get explicit third-party
 * carve-outs, and PRD D11 bars third-party origins from any report-
 * rendering route regardless). Self-hosting also means this confidential-
 * document product never has a browser make a font request to Google on
 * every page load. @fontsource ships the actual woff2 files as package
 * assets, so Vite bundles them at the app's own origin like any other
 * static asset — default-src 'self' already covers them, no CSP decision
 * deferred to a later step.
 *
 * Weights pulled in are exactly what the prototype uses (grep for
 * `font-weight` across the decoded prototype): 400/500/600/700 for both
 * faces, plus Literata italic 400 (the glossary tooltip's term line) and
 * Source Code Pro 400/500 (eyebrow labels and evidence badges).
 *
 * Subsets are `latin` and `latin-ext` only, not @fontsource's default
 * (every subset — cyrillic, greek, vietnamese — in one file). FR-7.14:
 * "Copy is English-only in Phase 1." latin-ext is kept alongside latin
 * because contract text isn't only UI copy — a party's name can carry an
 * accented Western-European character (é, ñ, ü) — but cyrillic and greek
 * would only ever be dead weight against FR-7.13's LCP budget. This cut
 * the built CSS from 66 KB to 25 KB (gzipped 31 KB to 10 KB) with the app
 * rendering identically.
 *
 * Side-effect-only CSS imports, so this has to be a JS module rather than
 * a .css file — a stylesheet cannot itself contain an `import` statement.
 */

import "@fontsource/literata/latin-400.css";
import "@fontsource/literata/latin-ext-400.css";
import "@fontsource/literata/latin-400-italic.css";
import "@fontsource/literata/latin-ext-400-italic.css";
import "@fontsource/literata/latin-500.css";
import "@fontsource/literata/latin-ext-500.css";
import "@fontsource/literata/latin-600.css";
import "@fontsource/literata/latin-ext-600.css";
import "@fontsource/literata/latin-700.css";
import "@fontsource/literata/latin-ext-700.css";
import "@fontsource/source-sans-3/latin-400.css";
import "@fontsource/source-sans-3/latin-ext-400.css";
import "@fontsource/source-sans-3/latin-500.css";
import "@fontsource/source-sans-3/latin-ext-500.css";
import "@fontsource/source-sans-3/latin-600.css";
import "@fontsource/source-sans-3/latin-ext-600.css";
import "@fontsource/source-sans-3/latin-700.css";
import "@fontsource/source-sans-3/latin-ext-700.css";
import "@fontsource/source-code-pro/latin-400.css";
import "@fontsource/source-code-pro/latin-ext-400.css";
import "@fontsource/source-code-pro/latin-500.css";
import "@fontsource/source-code-pro/latin-ext-500.css";
