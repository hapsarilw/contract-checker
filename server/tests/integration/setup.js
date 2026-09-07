import { afterEach } from "vitest";
import { truncateAll } from "./db.js";

/**
 * Runs after every integration test, so a test never has to remember to
 * clean up its own rows, and a failing test's leftovers can't leak into
 * the next test file.
 */
afterEach(async () => {
  await truncateAll();
});
