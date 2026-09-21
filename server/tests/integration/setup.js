import { afterAll, afterEach, beforeAll } from "vitest";
import { truncateAll } from "./db.js";
import { startTestServer, stopTestServer } from "./testServer.js";
import { getLlmProvider } from "../../src/services/llm/index.js";
import { MockLlmProvider } from "../../src/services/llm/mockProvider.js";
import { resetRateLimitsForTests } from "../../src/middleware/rateLimits.js";

/**
 * Runs after every integration test, so a test never has to remember to
 * clean up its own rows, and a failing test's leftovers can't leak into
 * the next test file. The mock provider is reset for the same reason: an
 * unconsumed script or a stale call log would otherwise reach the next test.
 *
 * The rate limiters are the same kind of shared state: one `app.js`
 * import per test file means its counters persist across every `it()` in
 * that file, not just within one test. Since step 44 those counters are in
 * Redis rather than in process memory, so the reset is a FLUSHDB and has
 * to be awaited — the database truncate below already was.
 */
afterEach(async () => {
  const provider = getLlmProvider().backend;
  if (provider instanceof MockLlmProvider) provider.reset();
  await resetRateLimitsForTests();
  await truncateAll();
});

/**
 * One HTTP server per test file, rather than one per request. See
 * testServer.js for the measurements that made this necessary: supertest
 * creates and destroys a server for every `request(app)` call, and at
 * thousands of cycles a response occasionally reaches the wrong client.
 */
beforeAll(async () => {
  await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
});
