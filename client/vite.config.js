import { defineConfig } from "vite";
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
});
