// Populates process.env with a valid, harmless configuration before any
// test module runs. Past step 3, importing almost anything transitively
// imports src/config.js, which validates process.env and calls
// process.exit(1) at module load on an invalid environment — without
// this file, every such test would fail to even import its subject.
//
// Tests that need to exercise config.js's OWN validation behavior do so
// out-of-process instead (see tests/unit/config.test.js), so mutating
// this shared environment here never conflicts with those.
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/clausecheck_test";
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-key";
process.env.ANTHROPIC_MODEL ??= "claude-haiku-4-5";
// §2.3: "ci: mock only — no network calls to the provider from CI." This
// is what enforces that for every test run, not just CI's own env config.
process.env.LLM_PROVIDER ??= "mock";
process.env.JWT_SECRET ??= "test-jwt-secret-at-least-32-bytes-long-ok";
process.env.FRONTEND_ORIGIN ??= "http://localhost:5173";
// Tests that deliberately exercise error paths (errorHandler.test.js)
// would otherwise flood stdout with real pino log lines on every run.
process.env.LOG_LEVEL ??= "silent";
