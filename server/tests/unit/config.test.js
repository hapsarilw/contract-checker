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

  it("resolves the SRS §5.4 parameter profile for the configured model", () => {
    const result = runConfig({ ANTHROPIC_MODEL: "claude-opus-5" });
    expect(result.status).toBe(0);
    const config = JSON.parse(result.stdout);
    expect(config.llmParamProfile).toEqual({
      temperature: false,
      effort: true,
      model: "claude-opus-5",
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
