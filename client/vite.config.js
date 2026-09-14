// `defineConfig` from "vitest/config" rather than plain "vite": it is the
// same Vite config type with a `test` field added, so this one file can
// hold both the app's build config and its test config instead of two
// files that could drift about which plugins run.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

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
export default defineConfig({
  plugins: [react()],
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
  },
});
