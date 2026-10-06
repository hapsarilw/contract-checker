import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const loaderScript = join(__dirname, "fixtures", "load-config.js");

const VALID_ENV = {
  PATH: process.env.PATH,
  NODE_ENV: "development",
  DATABASE_URL: "postgres://user:pass@localhost:5432/clausecheck",
  ANTHROPIC_API_KEY: "sk-ant-test",
  ANTHROPIC_MODEL: "claude-haiku-4-5",
  JWT_SECRET: "01234567890123456789012345678901",
  FRONTEND_ORIGIN: "https://app.example.com",
  REDIS_URL: "redis://localhost:6379",
  AUDIT_SALT: "test-audit-salt-at-least-32-bytes-long-ok",
  LLM_PRICE_INPUT_PER_MTOK: "2",
  LLM_PRICE_OUTPUT_PER_MTOK: "10",
  MONTHLY_SPEND_CEILING_USD: "100",
};

function runConfig(envOverrides) {
  return spawnSync(process.execPath, [loaderScript], {
    env: { ...VALID_ENV, ...envOverrides },
    encoding: "utf8",
  });
}

describe("config.js — validated at boot (SRS §8, Appendix B)", () => {
  it("parses a valid environment and exits 0", () => {
    const result = runConfig({});
    expect(result.status).toBe(0);
    const config = JSON.parse(result.stdout);
    expect(config.NODE_ENV).toBe("development");
    expect(config.ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
  });

  it("treats an empty value as unset, so a copy of .env.example boots", () => {
    const result = runConfig({
      LLM_TIMEOUT_MS: "",
      DEPLOY_ENV: "",
      LLM_PROVIDER: "",
      MOCK_LLM_DELAY_MS: "",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).timeouts.llm).toBe(60_000);
  });

  it("still refuses a REQUIRED variable left blank, naming it", () => {
    const result = runConfig({ DATABASE_URL: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL");
  });

  it("exits non-zero and names a missing required variable", () => {
    const envWithoutDatabaseUrl = Object.fromEntries(
      Object.entries(VALID_ENV).filter(([key]) => key !== "DATABASE_URL"),
    );
    const result = spawnSync(process.execPath, [loaderScript], {
      env: envWithoutDatabaseUrl,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL");
  });

  it("rejects a JWT_SECRET shorter than 32 bytes", () => {
    const result = runConfig({ JWT_SECRET: "too-short" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("JWT_SECRET");
  });

  it("rejects a numeric variable given a non-numeric string", () => {
    const result = runConfig({ PORT: "not-a-number" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PORT");
  });

  it("rejects an ANTHROPIC_MODEL with no §5.4 parameter profile", () => {
    const result = runConfig({ ANTHROPIC_MODEL: "claude-does-not-exist" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("claude-does-not-exist");
  });

  it('rejects ANALYSIS_ENABLED="false" as a string instead of treating it as truthy', () => {
    const result = runConfig({ ANALYSIS_ENABLED: "false" });
    expect(result.status).toBe(0);
    const config = JSON.parse(result.stdout);
    expect(config.ANALYSIS_ENABLED).toBe(false);
  });

  it("rejects an LLM_TIMEOUT_MS at or above the analyze ceiling (FR-3.7)", () => {
    // The timeout chain (proxy > server > analyze ceiling > LLM) has
    // exactly one env-tunable link, so it is the only one that can break
    // it. An LLM timeout above the ceiling means the ceiling cuts off an
    // analysis the provider was still answering.
    const result = runConfig({ LLM_TIMEOUT_MS: "120000" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LLM_TIMEOUT_MS");
    expect(result.stderr).toContain("analyze ceiling");
  });

  it("exposes the full resolved timeout chain in ascending order", () => {
    const result = runConfig({});
    expect(result.status).toBe(0);
    const { timeouts } = JSON.parse(result.stdout);

    expect(timeouts.llm).toBeLessThan(timeouts.analyzeCeiling);
    expect(timeouts.analyzeCeiling).toBeLessThan(timeouts.serverRequest);
    expect(timeouts.serverRequest).toBeLessThan(timeouts.keepAlive);
    expect(timeouts.keepAlive).toBeLessThan(timeouts.headers);
  });

  it("resolves the SRS §5.4 parameter profile for the configured model", () => {
    const result = runConfig({ ANTHROPIC_MODEL: "claude-opus-5" });
    expect(result.status).toBe(0);
    const config = JSON.parse(result.stdout);
    expect(config.llmParamProfile).toEqual({
      temperature: false,
      effort: true,
      model: "claude-opus-5",
      // Step 75: no geography asked for unless ANTHROPIC_INFERENCE_GEO says so.
      inferenceGeo: null,
    });
  });

  it("strips unrelated environment variables from the frozen config", () => {
    const result = runConfig({ SOME_UNRELATED_SHELL_VAR: "x" });
    expect(result.status).toBe(0);
    const config = JSON.parse(result.stdout);
    expect(config).not.toHaveProperty("SOME_UNRELATED_SHELL_VAR");
    expect(config).not.toHaveProperty("PATH");
  });
});

describe("config.js — the email provider (step 51)", () => {
  it('defaults to the "sink" provider outside production', () => {
    const result = runConfig({});
    expect(result.status).toBe(0);
  });

  it("refuses to boot with the sink provider in production", () => {
    // "Written to a file" counts as success, so a sink in production would
    // swallow every verification and reset email with no error anywhere —
    // accounts created, nobody able to verify. Boot is the only place that
    // failure is loud.
    const result = runConfig({ NODE_ENV: "production", EMAIL_PROVIDER: "sink" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EMAIL_PROVIDER");
    expect(result.stderr).toMatch(/must not run in production/);
  });

  it("refuses the sink in production even when EMAIL_PROVIDER is simply unset", () => {
    // The default is "sink", so forgetting to configure a provider must
    // not fall through to it silently.
    const result = runConfig({ NODE_ENV: "production" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EMAIL_PROVIDER");
  });

  it("rejects a provider it does not know", () => {
    const result = runConfig({ EMAIL_PROVIDER: "carrier-pigeon" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EMAIL_PROVIDER");
  });
});

describe("config.js — DATABASE_POOL_SIZE (step 69)", () => {
  it("refuses a pool smaller than 5, naming why", () => {
    // Found by the db-pool-saturated runbook walkthrough: with a pool of 1
    // the reaper's lock transaction held the only connection and its work
    // waited for a second one forever, wedging the whole process.
    const result = runConfig({ DATABASE_POOL_SIZE: "4" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_POOL_SIZE");
    expect(result.stderr).toMatch(/at least 5/);
  });

  it("accepts 5, and defaults to 10", () => {
    expect(runConfig({ DATABASE_POOL_SIZE: "5" }).status).toBe(0);
    expect(JSON.parse(runConfig({}).stdout).DATABASE_POOL_SIZE).toBe(10);
  });
});

describe("config.js — observability (step 67)", () => {
  it("refuses to boot in production without METRICS_TOKEN, naming it", () => {
    // Without it nothing can be scraped and no alert can fire.
    const result = runConfig({ NODE_ENV: "production" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("METRICS_TOKEN");
  });

  it("rejects a METRICS_TOKEN shorter than 32 bytes", () => {
    const result = runConfig({ METRICS_TOKEN: "short" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("METRICS_TOKEN");
  });

  it("is fine without METRICS_TOKEN outside production (the route is simply absent)", () => {
    expect(runConfig({}).status).toBe(0);
  });

  const SYNTHETIC = {
    SYNTHETIC_CHECK_TOKEN: "synthetic-token-at-least-32-bytes-long",
    SYNTHETIC_CHECK_IPS: "203.0.113.0/24",
    SYNTHETIC_ACCOUNT_EMAIL: "synthetic@example.test",
  };

  it("accepts the synthetic-check trio together", () => {
    expect(runConfig(SYNTHETIC).status).toBe(0);
  });

  it.each(Object.keys(SYNTHETIC))(
    "refuses the synthetic-check trio with %s missing",
    (missing) => {
      const partial = Object.fromEntries(
        Object.entries(SYNTHETIC).filter(([key]) => key !== missing),
      );
      const result = runConfig(partial);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/set together or not at all/);
    },
  );

  it("refuses to boot in production without MEMORY_LIMIT_BYTES, naming it", () => {
    // Appendix C's memory_high is "RSS > 80% of limit". With no limit the
    // rule's denominator is absent and the alert can never fire, which is
    // worse than not having it: it looks like coverage.
    const result = runConfig({ NODE_ENV: "production", METRICS_TOKEN: "m".repeat(32) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MEMORY_LIMIT_BYTES");
  });

  it("refuses to boot in production when the alert-drill token is set at all", () => {
    // The drill routes plant an unverifiable excerpt and read a document
    // across users (step 68). This is the layer that makes them impossible in
    // production regardless of any mistake in the mounting or the token check.
    const result = runConfig({
      NODE_ENV: "production",
      METRICS_TOKEN: "m".repeat(32),
      MEMORY_LIMIT_BYTES: "536870912",
      EMAIL_PROVIDER: "sink",
      ALERT_DRILL_TOKEN: "d".repeat(32),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ALERT_DRILL_TOKEN");
    expect(result.stderr).toMatch(/must not be set in production/);
  });

  // Step 71. Staging runs the production image in production mode, so none
  // of these can reach exit 0 today — the sink email provider is refused in
  // production mode and no other provider exists yet. Each test therefore
  // asserts on WHICH variables the refusal names, by the "  NAME: message"
  // line formatIssue prints, not on the exit code alone.
  const PROD_MODE = {
    NODE_ENV: "production",
    METRICS_TOKEN: "m".repeat(32),
    MEMORY_LIMIT_BYTES: "536870912",
  };
  /** @param {string} stderr */
  const namedIssues = (stderr) =>
    [...stderr.matchAll(/^ {2}([A-Z_]+):/gm)].map((m) => m[1]);

  it("requires DEPLOY_ENV in production mode, naming it", () => {
    expect(namedIssues(runConfig(PROD_MODE).stderr)).toContain("DEPLOY_ENV");
  });

  it("accepts either deployment name in production mode", () => {
    for (const DEPLOY_ENV of ["staging", "production"]) {
      expect(
        namedIssues(runConfig({ ...PROD_MODE, DEPLOY_ENV }).stderr),
        DEPLOY_ENV,
      ).not.toContain("DEPLOY_ENV");
    }
  });

  it("refuses DEPLOY_ENV outside production mode", () => {
    const result = runConfig({ DEPLOY_ENV: "staging" });
    expect(result.status).not.toBe(0);
    expect(namedIssues(result.stderr)).toContain("DEPLOY_ENV");
  });

  it("refuses the mock provider in production mode, staging included", () => {
    // A canned analysis that no model wrote, served as a real report.
    for (const DEPLOY_ENV of ["staging", "production"]) {
      const result = runConfig({ ...PROD_MODE, DEPLOY_ENV, LLM_PROVIDER: "mock" });
      expect(namedIssues(result.stderr), DEPLOY_ENV).toContain("LLM_PROVIDER");
    }
    expect(
      namedIssues(
        runConfig({ ...PROD_MODE, DEPLOY_ENV: "production", LLM_PROVIDER: "anthropic" })
          .stderr,
      ),
    ).not.toContain("LLM_PROVIDER");
  });

  it("allows the alert-drill token in staging, and only there among production-mode deployments", () => {
    const token = { ALERT_DRILL_TOKEN: "d".repeat(32) };
    expect(
      namedIssues(runConfig({ ...PROD_MODE, DEPLOY_ENV: "staging", ...token }).stderr),
    ).not.toContain("ALERT_DRILL_TOKEN");
    expect(
      namedIssues(runConfig({ ...PROD_MODE, DEPLOY_ENV: "production", ...token }).stderr),
    ).toContain("ALERT_DRILL_TOKEN");
    // Production mode that does not say which it is counts as production.
    expect(namedIssues(runConfig({ ...PROD_MODE, ...token }).stderr)).toContain(
      "ALERT_DRILL_TOKEN",
    );
  });

  it("accepts MOCK_LLM_DELAY_MS with the mock provider, and refuses it with the real one", () => {
    expect(runConfig({ LLM_PROVIDER: "mock", MOCK_LLM_DELAY_MS: "50000" }).status).toBe(
      0,
    );
    const result = runConfig({ LLM_PROVIDER: "anthropic", MOCK_LLM_DELAY_MS: "50000" });
    expect(result.status).not.toBe(0);
    expect(namedIssues(result.stderr)).toContain("MOCK_LLM_DELAY_MS");
  });

  it("parses at most two uploads at once per instance by default (step 73's TR-23)", () => {
    // Ten at once killed a 512 MB instance with no swap; two kept the
    // cgroup peak near 55%. Changing this default means re-running TR-23
    // (ops/load/run-local.sh tr23), not just this test.
    const config = JSON.parse(runConfig({}).stdout);
    expect(config.MAX_CONCURRENT_EXTRACTIONS).toBe(2);
    expect(config.MAX_CONCURRENT_UPLOADS).toBe(10);
  });

  it("accepts MOCK_LLM_OUTAGE_FILE with the mock provider only", () => {
    expect(
      runConfig({ LLM_PROVIDER: "mock", MOCK_LLM_OUTAGE_FILE: "/tmp/outage" }).status,
    ).toBe(0);
    const result = runConfig({
      LLM_PROVIDER: "anthropic",
      MOCK_LLM_OUTAGE_FILE: "/tmp/outage",
    });
    expect(result.status).not.toBe(0);
    expect(namedIssues(result.stderr)).toContain("MOCK_LLM_OUTAGE_FILE");
  });

  it("accepts MOCK_LLM_FINDINGS with the mock provider only", () => {
    expect(
      runConfig({ LLM_PROVIDER: "mock", MOCK_LLM_FINDINGS: "quote-document" }).status,
    ).toBe(0);
    const result = runConfig({
      LLM_PROVIDER: "anthropic",
      MOCK_LLM_FINDINGS: "quote-document",
    });
    expect(result.status).not.toBe(0);
    expect(namedIssues(result.stderr)).toContain("MOCK_LLM_FINDINGS");
    expect(
      runConfig({ LLM_PROVIDER: "mock", MOCK_LLM_FINDINGS: "everything" }).status,
    ).not.toBe(0);
  });

  it("accepts the alert-drill token outside production", () => {
    expect(runConfig({ ALERT_DRILL_TOKEN: "d".repeat(32) }).status).toBe(0);
  });

  it("rejects an alert-drill token shorter than 32 bytes", () => {
    const result = runConfig({ ALERT_DRILL_TOKEN: "short" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ALERT_DRILL_TOKEN");
  });

  it("refuses an allowlist entry that is not an address or a range, naming it", () => {
    const result = runConfig({
      ...SYNTHETIC,
      SYNTHETIC_CHECK_IPS: "203.0.113.0/24, checker.example.com",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checker.example.com");
  });
});
