// `defineConfig` from "vitest/config" rather than plain "vite": it is the
// same Vite config type with a `test` field added, so this one file can
// hold both the app's build config and its test config instead of two
// files that could drift about which plugins run.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import process from "node:process";
import { staticHostHeaders } from "./scripts/staticHostHeaders.js";

/**
 * FR-7.9 — Vite's default production output already satisfies "no inline
 * script": the built index.html gets a single
 * `<script type="module" src="/assets/index-<hash>.js">`, an external file
 * at the app's own origin, never an inline bootstrap. (Create React App's
 * webpack output inlines one; that default is what made this worth
 * deciding explicitly instead of discovering it after screens exist.) The
 * one thing this config must keep true, forever: no plugin here that
 * injects an inline `<script>` into index.html (an analytics snippet, a
 * theme-flash preventer, anything of that shape) — verified by
 * `scripts/check-bundle-size.mjs`, which also asserts this on every build.
 */
/**
 * FR-7.13 (BUILD-PLAN step 66): preload the body-text font.
 *
 * Largest Contentful Paint on every screen is a block of body text set in
 * Host Grotesk (Geist before the post-step-75 redesign; Host Grotesk's
 * latin file is 20 KB against Geist's 29 KB), and without a preload the
 * browser cannot even ask for the font until it has downloaded and parsed
 * the stylesheet and laid out text that uses it. The preload starts the download alongside the HTML instead.
 * It is the ONE font preloaded, and only its latin subset: it is used on
 * every page, so the early bytes are never wasted. Literata (the report's
 * excerpts) and Geist Mono are left to load on demand; preloading them on
 * pages that never use them would take bandwidth from the text that is
 * the LCP.
 *
 * The file name is content-hashed, so it is found in the bundle at build
 * time rather than written into index.html by hand. A build that cannot
 * find it FAILS, rather than silently shipping without the preload the
 * LCP budget depends on. `crossorigin` is required for a font preload
 * even on the same origin, or the browser fetches it twice. A <link> is
 * not a script, so FR-7.9's no-inline-script rule is untouched.
 *
 * @returns {import("vite").Plugin}
 */
function preloadBodyFont() {
  const PATTERN = /(^|\/)host-grotesk-latin-wght-normal-[\w-]+\.woff2$/;
  return {
    name: "clausecheck:preload-body-font",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const file = Object.keys(ctx.bundle ?? {}).find((name) => PATTERN.test(name));
        if (!file) {
          throw new Error(
            "preload-body-font: no host-grotesk-latin-wght-normal woff2 in the bundle; " +
              "the body font changed, so update this plugin (FR-7.13 depends on it).",
          );
        }
        return [
          {
            tag: "link",
            attrs: {
              rel: "preload",
              href: `/${file}`,
              as: "font",
              type: "font/woff2",
              crossorigin: "",
            },
            injectTo: "head",
          },
        ];
      },
    },
  };
}

/**
 * Step 75: the static host's `_headers` (FR-7.9's CSP and the rest), built
 * for the API this build talks to. See scripts/staticHostHeaders.js.
 * @returns {import("vite").Plugin}
 */
function staticHostHeadersFile() {
  return {
    name: "clausecheck:static-host-headers",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: staticHostHeaders(process.env.VITE_API_BASE_URL),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), preloadBodyFont(), staticHostHeadersFile()],
  build: {
    // No inline sourcemap script, no legacy inline shims.
    sourcemap: true,
  },
  test: {
    // jsdom, not "node": these are component tests (render, click,
    // read the accessibility tree) — server's vitest.config.js uses
    // "node" because it has no DOM to render into.
    environment: "jsdom",
    include: ["tests/unit/**/*.test.{js,jsx}"],
    setupFiles: ["./tests/setup.js"],
    // A fixed zone AHEAD of UTC, so the run is the same on every machine
    // and in CI (which is UTC), and so a date computed in local time
    // instead of UTC differs from the right answer and a test can see it
    // (the quota reset date, analyzeErrors.js). In UTC the two are
    // identical and such a bug is invisible.
    env: { TZ: "Asia/Jakarta" },
  },
});
