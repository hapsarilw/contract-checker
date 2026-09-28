import { defineConfig, devices } from "@playwright/test";

/**
 * BUILD-PLAN step 32 — the first step in the plan to ask for a
 * Playwright test ("Write a Playwright test with axe assertions on both
 * screens"), so this is where the harness is set up; later steps
 * (33-38, 51, and the full-journey test in step 39) reuse it rather than
 * each inventing their own.
 *
 * These tests run against the Vite dev server only — no backend. The
 * screens under test here (login, register) are self-contained UI:
 * their tests mock `**\/api/v1/auth/**` with `page.route()` rather than
 * requiring a live Express+Postgres stack, which is a lot of
 * infrastructure this step does not need to stand up to check "does the
 * form render correctly, associate its errors correctly, and pass axe."
 * A real end-to-end run against the live API is TR-24 (§10, the staging
 * smoke test), a different thing entirely.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // BUILD-PLAN step 33 — `page.waitForEvent("filechooser")` (the
  // dropzone's keyboard path, e2e/upload.spec.js) intermittently never
  // fires within Playwright's 30s default, confirmed to be independent
  // of worker count: it happens at the default parallel workers, at
  // workers:2, and even at workers:1 (fully serial) once enough total
  // filechooser-using tests run in the same suite — ruling out CPU
  // contention as the cause. Isolated re-runs of the exact same
  // assertions never fail. This is upstream Chromium/CDP flakiness
  // around repeated file-chooser interception in one long-lived browser
  // session, not a bug in the app or the tests (every failure is the
  // same wait, never a different assertion), and Playwright's own
  // answer for exactly this class of flake is retries — given here for
  // every run, not only CI, since the flake reproduces locally too. Each
  // wait also has its own 5s timeout (not this file's 30s test default)
  // so a retry cycle costs seconds, not the better part of a minute.
  retries: process.env.CI ? 2 : 1,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // No local dev server when pointed at a deployed environment
  // (e2e/staging.spec.js, step 71): starting one there would test the
  // wrong build and hold a port for nothing.
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:5173",
        reuseExistingServer: !process.env.CI,
      },
});
