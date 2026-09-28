import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/report-scan-failure.sh: how a failed weekly scan reaches the
 * maintainer (step 71's decision). Run for real against a stand-in `gh` on
 * PATH that records its arguments, so what is asserted is the exact calls
 * the script would make to GitHub.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(ROOT, "scripts", "report-scan-failure.sh");
const RUN = "https://github.com/o/r/actions/runs/42";

/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * @param {string[]} args
 * @param {{ openIssue?: string }} [options] what `gh issue list` answers
 */
function run(args, { openIssue = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  dirs.push(dir);
  const log = join(dir, "calls.jsonl");
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "issue" && process.argv[3] === "list") process.stdout.write(${JSON.stringify(openIssue)});
`,
  );
  chmodSync(gh, 0o755);
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  /** @type {string[][]} */
  let calls = [];
  try {
    calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    // no calls made
  }
  return { ...result, calls };
}

/** @param {string[][]} calls @param {string} a @param {string} b */
const find = (calls, a, b) => calls.find((c) => c[0] === a && c[1] === b);
/** @param {string[]} call @param {string} flag */
const flag = (call, flag) => call[call.indexOf(flag) + 1];

describe("report-scan-failure.sh", () => {
  it("opens an issue labelled with the alert's name when none is open", () => {
    const { status, calls } = run([RUN, "dependencies=failure", "image=success"]);
    expect(status).toBe(0);
    const create = find(calls, "issue", "create");
    expect(create).toBeDefined();
    expect(flag(/** @type {string[]} */ (create), "--label")).toBe(
      "dependency_critical_vuln",
    );
    expect(find(calls, "issue", "comment")).toBeUndefined();
  });

  it("comments on the open issue instead of opening a second one", () => {
    const { status, calls } = run([RUN, "dependencies=success", "image=failure"], {
      openIssue: "7",
    });
    expect(status).toBe(0);
    const comment = find(calls, "issue", "comment");
    expect(comment?.[2]).toBe("7");
    expect(find(calls, "issue", "create")).toBeUndefined();
  });

  it("says which scan failed, links the run and the runbook, and gives the 7-day date", () => {
    const { calls } = run([RUN, "dependencies=failure", "image=failure"]);
    const body = flag(/** @type {string[]} */ (find(calls, "issue", "create")), "--body");
    expect(body).toContain("dependencies image");
    expect(body).toContain(RUN);
    expect(body).toContain("docs/runbooks/dependency-critical-vuln.md");
    const deadline = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    expect(body).toContain(deadline);
  });

  it("does nothing at all when no scan job failed (a cancelled run, say)", () => {
    const { status, calls } = run([RUN, "dependencies=success", "image=cancelled"]);
    expect(status).toBe(0);
    expect(calls).toEqual([]);
  });

  it("is never wired to the secret scan", () => {
    // A public issue pointing at a leaked credential before rotation is
    // worse than silence; see the script's header.
    const scan = readFileSync(join(ROOT, ".github", "workflows", "scan.yml"), "utf8");
    const report = /\n {2}report:\n[\s\S]*?\n {2}secrets:/.exec(scan)?.[0] ?? "";
    expect(report).toContain("needs: [dependencies, image]");
    expect(report).not.toMatch(/needs\.secrets/);
  });
});
