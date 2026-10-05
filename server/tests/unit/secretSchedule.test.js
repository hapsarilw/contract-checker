import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * SRS §12.5 / BUILD-PLAN step 74: every secret the system holds has a row
 * in the rotation schedule (docs/runbooks/secret-rotation.md). A secret
 * added to config.js or to a workflow without one fails here, because a
 * secret nobody scheduled is a secret nobody rotates.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runbook = readFileSync(
  join(ROOT, "docs", "runbooks", "secret-rotation.md"),
  "utf8",
);
const schedule = runbook.slice(
  runbook.indexOf("## Schedule"),
  runbook.indexOf("## Per secret"),
);
const scheduled = [...schedule.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]);

const SECRET_NAME = /(SECRET|TOKEN|_KEY|SALT|PASSWORD|_DSN|DATABASE_URL|REDIS_URL)$/;

function configSecrets() {
  const source = readFileSync(join(ROOT, "server", "src", "config.js"), "utf8");
  const schema = source.slice(
    source.indexOf("const envSchema"),
    source.indexOf("\n  .superRefine((env, ctx)"),
  );
  return [
    ...new Set([...schema.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1])),
  ].filter((n) => SECRET_NAME.test(n));
}

function workflowSecrets() {
  const dir = join(ROOT, ".github", "workflows");
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .flatMap((line) => [...line.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1])),
    );
  return [...new Set(names)];
}

describe("every secret has a rotation schedule", () => {
  it("finds the secrets it is checking (a reader that finds none passes everything)", () => {
    expect(configSecrets()).toEqual(
      expect.arrayContaining(["JWT_SECRET", "ANTHROPIC_API_KEY", "AUDIT_SALT"]),
    );
    expect(workflowSecrets()).toEqual(
      expect.arrayContaining(["PLATFORM_TOKEN", "ANTHROPIC_BENCHMARK_KEY"]),
    );
  });

  it.each(configSecrets())("config.js's %s", (name) => {
    expect(scheduled).toContain(name);
  });

  it.each(workflowSecrets())("the workflows' %s", (name) => {
    expect(scheduled).toContain(name);
  });

  it("states that AUDIT_SALT is never rotated, and that exposure is a Severity 1", () => {
    expect(schedule).toMatch(/`AUDIT_SALT` \|[^\n]*\*\*never\*\*/);
    expect(schedule).toMatch(/Severity 1: rotate first, investigate second/);
  });
});
