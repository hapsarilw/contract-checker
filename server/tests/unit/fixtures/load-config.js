// Spawned as a child process by tests/unit/config.test.js with a controlled
// env. Importing config.js runs its module-load side effect (parse + exit),
// so the only way to observe "did boot succeed, and with what exit code" is
// out-of-process — importing it in-process on a bad env would kill the test
// runner itself via process.exit(1).
import config from "../../../src/config.js";

console.log(JSON.stringify(config));
