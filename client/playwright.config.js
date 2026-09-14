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
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
