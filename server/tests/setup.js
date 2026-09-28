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
// Required since step 44. Unit tests never connect — lib/redis.js builds
// its client on first use, not at import — so this only has to satisfy the
// config schema. Integration tests get a real one from globalSetup.js.
process.env.REDIS_URL ??= "redis://localhost:6379";
// Required since step 46 (FR-5.3). Round numbers, not the real ones: a
// test asserting on spend should read its own arithmetic, not a price list.
// Required since step 56 (audit hmac salt). Distinct from JWT_SECRET so
// a test that mutates one cannot accidentally affect the other.
process.env.AUDIT_SALT ??= "test-audit-salt-at-least-32-bytes-long-ok";
process.env.LLM_PRICE_INPUT_PER_MTOK ??= "1";
process.env.LLM_PRICE_OUTPUT_PER_MTOK ??= "10";
process.env.MONTHLY_SPEND_CEILING_USD ??= "100";
process.env.JWT_SECRET ??= "test-jwt-secret-at-least-32-bytes-long-ok";
process.env.FRONTEND_ORIGIN ??= "http://localhost:5173";
// Tests that deliberately exercise error paths (errorHandler.test.js)
// would otherwise flood stdout with real pino log lines on every run.
process.env.LOG_LEVEL ??= "silent";
// Step 67. A metrics token, so GET /metrics is live in tests, and the
// synthetic-check trio, so the auth limiter's bypass can be exercised. The
// allowlist is loopback plus 198.51.100.0/24 (RFC 5737, documentation-only
// addresses) for tests that simulate a checker via X-Forwarded-For.
process.env.METRICS_TOKEN ??= "test-metrics-token-at-least-32-bytes-ok";
process.env.SYNTHETIC_CHECK_TOKEN ??= "test-synthetic-token-at-least-32-bytes";
process.env.SYNTHETIC_CHECK_IPS ??= "127.0.0.1,::1,198.51.100.0/24";
process.env.SYNTHETIC_ACCOUNT_EMAIL ??= "synthetic@example.test";
// Step 68. A memory limit so Appendix C's memory_high has a denominator, and
// the drill token that mounts routes/drills.js — the staging-only way to
// force the two Sev-1 alerts whose conditions the pipeline prevents.
// config.js refuses to boot in production with the drill token set at all.
process.env.MEMORY_LIMIT_BYTES ??= "536870912";
process.env.ALERT_DRILL_TOKEN ??= "test-alert-drill-token-at-least-32-b";
