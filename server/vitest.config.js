import { defineConfig } from "vitest/config";

/**
 * Two projects, deliberately separated (SRS §10):
 *
 *   unit         — no database, no network, no container. Fast enough to run
 *                  on every save.
 *   integration  — runs against an ephemeral Postgres and the mock LLM
 *                  provider (LLM_PROVIDER=mock). Wired in step 11; the
 *                  project exists now so the split never has to be
 *                  retrofitted.
 *
 * Coverage thresholds are SRS §10.5's numbers. They apply only when coverage
 * is requested, so `npm test` on an empty suite stays green.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.js"],
          environment: "node",
          setupFiles: ["./tests/setup.js"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.js"],
          environment: "node",
          // Runs once, before any integration test file: starts the
          // ephemeral Postgres and applies migrations against it.
          globalSetup: "./tests/integration/globalSetup.js",
          // tests/setup.js: the shared env bootstrap every project uses.
          // tests/integration/setup.js: truncates every table after each
          // test, so state never leaks between them.
          setupFiles: ["./tests/setup.js", "./tests/integration/setup.js"],
          // Every integration file shares ONE ephemeral Postgres and
          // truncates it after each test (tests/integration/setup.js).
          // Running files in parallel means one file's TRUNCATE (an
          // ACCESS EXCLUSIVE lock) collides with another file's
          // in-flight writes — observed directly as both deadlock
          // errors and silently-vanished rows, not a hypothetical.
          // Integration tests trade file-level parallelism for
          // correctness against a shared resource; unit tests keep it.
          maxWorkers: 1,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.js"],
      exclude: ["src/**/*.test.js"],
      thresholds: {
        // SRS §10.5: line coverage over server/src.
        lines: 80,

        // SRS §10.5 also requires 100% BRANCH coverage on
        // src/services/verify.js and src/services/risk.js. Those files do not
        // exist yet (steps 20 and 21). Once they do, add per-file thresholds:
        //
        //   "src/services/verify.js": { branches: 100 },
        //   "src/services/risk.js":   { branches: 100 },
        //
        // This is not a vanity number. The verifier is the control that makes
        // the product's verifiability claim true, and an untested branch in it
        // is an untested path to showing a user a fabricated clause.
      },
    },
  },
});
