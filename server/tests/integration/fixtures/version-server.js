// Spawned as a child process by tests/integration/ops.test.js.
//
// config.js is a frozen singleton read once at import time, so the only
// way to test /api/version against a DIFFERENT GIT_SHA/BUILD_TIMESTAMP
// than the shared test environment (tests/setup.js) is a separate process
// with its own env — the same reason tests/unit/config.test.js spawns
// rather than importing in-process.
import app from "../../../src/app.js";

const server = app.listen(0, () => {
  const address = server.address();
  process.stdout.write(`LISTENING:${typeof address === "object" && address ? address.port : ""}\n`);
});
