import { afterEach } from "vitest";
import { truncateAll } from "./db.js";
import { getLlmProvider } from "../../src/services/llm/index.js";
import { MockLlmProvider } from "../../src/services/llm/mockProvider.js";
import { resetRateLimitsForTests } from "../../src/middleware/rateLimits.js";

/**
 * Runs after every integration test, so a test never has to remember to
 * clean up its own rows, and a failing test's leftovers can't leak into
 * the next test file. The mock provider is reset for the same reason: an
 * unconsumed script or a stale call log would otherwise reach the next test.
 *
 * The rate limiters (step 41) are the same kind of shared, in-process
 * state: one `app.js` import per test file means its limiters' counters
 * persist across every `it()` in that file, not just within one test.
 */
afterEach(async () => {
  const provider = getLlmProvider().backend;
  if (provider instanceof MockLlmProvider) provider.reset();
  resetRateLimitsForTests();
  await truncateAll();
});
