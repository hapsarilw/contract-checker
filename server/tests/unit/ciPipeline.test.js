import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * BUILD-PLAN step 70: the CI pipeline, checked for the things that make it
 * a gate rather than a decoration and that rot silently when someone edits a
 * workflow. Nothing here runs the pipeline (only GitHub can); it holds the
 * FILES to what step 70's "done when" and SRS §12.1 / §10.5 require:
 *
 *   - every §12.1 pull-request stage is present, and none is advisory;
 *   - the job names ci.yml defines are exactly the names branch protection
 *     requires (docs/branch-protection.md and the script that applies it),
 *     because GitHub accepts a required check that never reports and then
 *     the branch can never merge;
 *   - no workflow but the benchmark holds a provider key (SRS §2.3);
 *   - the coverage gates carry SRS §10.5's numbers;
 *   - scanners are pinned, not floating;
 *   - CODEOWNERS covers exactly the four paths §12.1 names, and they exist.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

const ciText = read(".github", "workflows", "ci.yml");
const scanText = read(".github", "workflows", "scan.yml");
const ci = parse(ciText);
const scan = parse(scanText);

/** @param {any} job @returns {string[]} */
const runs = (job) => job.steps.map((step) => step.run ?? "").filter(Boolean);

describe("every SRS §12.1 pull-request stage is a job, and all of them gate", () => {
  const jobs = ci.jobs;

  it("runs on every pull request", () => {
    expect(Object.keys(ci.on)).toContain("pull_request");
  });

  it.each([
    [
      "server-quality",
      [
        "npm ci",
        "npm run lint",
        "prettier --check",
        "npm run typecheck",
        "npm run test:unit",
      ],
    ],
    [
      "client-quality",
      ["npm ci", "npm run lint", "prettier --check", "npm run typecheck", "vitest run"],
    ],
    ["server-tests", ["npm ci", "npm run test:integration", "npm run test:coverage"]],
    [
      "client-build",
      ["npm ci", "npm run build", "npm run bundle:check", "npm run perf:lcp"],
    ],
    ["client-e2e", ["npm ci", "npm run e2e"]],
    ["docker-build", ["docker build"]],
    ["dependency-scan", ["npm audit --audit-level=critical"]],
    ["image-scan", ["trivy", "--severity CRITICAL", "--exit-code 1"]],
    ["secret-scan", ["gitleaks"]],
    ["openapi-contract-test", ["tests/unit/openapi.test.js"]],
    ["fixtures-verify", ["npm run fixtures:verify"]],
  ])("%s runs what its stage names", (name, expected) => {
    expect(jobs[name], `ci.yml has no job "${name}"`).toBeDefined();
    const commands = runs(jobs[name]).join("\n");
    for (const fragment of expected)
      expect(commands, `${name}: ${fragment}`).toContain(fragment);
  });

  it("dependency-scan gates BOTH packages on critical, each in its own directory", () => {
    // A single `toContain` above passes if only one of the two audits gates:
    // weakening the server's alone (the one with real advisories in it) went
    // unnoticed by a mutation before this was added.
    const audits = jobs["dependency-scan"].steps.filter((step) =>
      /npm audit/.test(step.run ?? ""),
    );
    expect(audits.map((step) => step["working-directory"]).sort()).toEqual([
      "client",
      "server",
    ]);
    for (const step of audits)
      expect(step.run, step["working-directory"]).toContain("--audit-level=critical");
  });

  it("installs from the frozen lockfile, never `npm install`", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const commands = runs(/** @type {any} */ (job)).join("\n");
      expect(commands, name).not.toMatch(/npm install\b/);
    }
  });

  it("nothing is advisory: no continue-on-error, no `|| true`", () => {
    // "all steps gating" (BUILD-PLAN step 70). scan.yml may print a full
    // report before its gating step; ci.yml never.
    expect(ciText).not.toMatch(/continue-on-error/);
    expect(ciText).not.toMatch(/\|\|\s*true/);
  });

  it("every `needs` names a job that exists, and there is no cycle", () => {
    const names = new Set(Object.keys(jobs));
    for (const [name, job] of Object.entries(jobs)) {
      for (const need of /** @type {any} */ (job).needs ?? []) {
        expect(names.has(need), `${name} needs unknown job ${need}`).toBe(true);
      }
    }
    // A job is reachable from itself only through a cycle.
    const reaches = (from, target, seen = new Set()) => {
      for (const need of jobs[from].needs ?? []) {
        if (need === target) return true;
        if (!seen.has(need)) {
          seen.add(need);
          if (reaches(need, target, seen)) return true;
        }
      }
      return false;
    };
    for (const name of names)
      expect(reaches(name, name), `${name} is in a cycle`).toBe(false);
  });

  it("the genuine prerequisites are real edges", () => {
    // Not because order is sacred, but because these are the ones that
    // cannot be skipped: you cannot scan an image before building it, and
    // an image should not be built from code whose tests failed.
    expect(jobs["image-scan"].needs).toContain("docker-build");
    expect(jobs["docker-build"].needs).toContain("server-tests");
    expect(jobs["server-tests"].needs).toContain("server-quality");
    expect(jobs["client-build"].needs).toContain("client-quality");
  });
});

describe("branch protection requires exactly the jobs ci.yml defines", () => {
  const jobNames = Object.keys(ci.jobs).sort();

  it("docs/branch-protection.md's table", () => {
    const doc = read("docs", "branch-protection.md");
    const table = doc.slice(
      doc.indexOf("| Required check |"),
      doc.indexOf("## The review rule"),
    );
    const listed = [...table.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]).sort();
    expect(listed).toEqual(jobNames);
  });

  it("scripts/configure-branch-protection.sh's CHECKS array", () => {
    const script = read("scripts", "configure-branch-protection.sh");
    const block = /CHECKS=\(([^)]*)\)/.exec(script)?.[1] ?? "";
    const listed = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();
    expect(listed).toEqual(jobNames);
  });

  it("a job's `name:` is its key, since GitHub reports the name", () => {
    for (const [key, job] of Object.entries(ci.jobs)) {
      expect(/** @type {any} */ (job).name, key).toBe(key);
    }
  });
});

describe("no workflow but the benchmark holds a provider key (SRS §2.3)", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));

  it.each(files.filter((f) => f !== "benchmark.yml"))("%s", (file) => {
    // The parsed workflow, not the raw text: comments here name the key to
    // say it is absent, which is not the same as using it.
    const text = JSON.stringify(parse(readFileSync(join(WORKFLOWS, file), "utf8")));
    expect(text).not.toMatch(/ANTHROPIC/i);
    // Any secret at all is a decision worth a look in a workflow that is
    // meant to need none.
    expect(text).not.toMatch(/secrets\.[A-Z_]+/);
  });

  it.each(["ci.yml", "scan.yml"])(
    "%s sets LLM_PROVIDER=mock at the workflow level",
    (file) => {
      const workflow = file === "ci.yml" ? ci : scan;
      expect(workflow.env.LLM_PROVIDER).toBe("mock");
    },
  );
});

describe("the coverage gates carry SRS §10.5's numbers", () => {
  const config = read("server", "vitest.config.js");

  it("80% of lines over server/src", () => {
    expect(config).toMatch(/lines:\s*80\b/);
  });

  it("100% branch coverage on verify.js and risk.js", () => {
    expect(config).toMatch(/"src\/services\/verify\.js":\s*\{\s*branches:\s*100\s*\}/);
    expect(config).toMatch(/"src\/services\/risk\.js":\s*\{\s*branches:\s*100\s*\}/);
  });

  it("and ci.yml runs the coverage script that enforces them", () => {
    expect(read("server", "package.json")).toMatch(
      /"test:coverage":\s*"vitest run --coverage"/,
    );
    expect(runs(ci.jobs["server-tests"]).join("\n")).toContain("npm run test:coverage");
  });
});

describe("scanners are pinned, and scan.yml tells apart what ci.yml ignores", () => {
  const images = [
    ...`${ciText}\n${scanText}`.matchAll(
      /(aquasec\/trivy|zricethezav\/gitleaks|rhysd\/actionlint):([^\s\\]+)/g,
    ),
  ];

  it("uses each scanner image at least once, never :latest", () => {
    expect(images.length).toBeGreaterThan(0);
    for (const [, image, tag] of images) expect(tag, image).toMatch(/^v?\d+\.\d+\.\d+$/);
  });

  it("ci.yml ignores unfixed criticals; the weekly scan does not", () => {
    expect(ciText).toContain("--ignore-unfixed");
    expect(scanText).not.toMatch(/--severity CRITICAL --ignore-unfixed/);
    // Its fail-on-critical step has no --ignore-unfixed at all.
    const failStep =
      /fail on any critical[\s\S]*?clausecheck-server:weekly/.exec(scanText)?.[0] ?? "";
    expect(failStep).toContain("--exit-code 1");
    expect(failStep).not.toContain("--ignore-unfixed");
  });

  it("scan.yml runs weekly on a schedule, and can be run by hand", () => {
    expect(scan.on.schedule[0].cron).toMatch(/^\S+ \S+ \S+ \S+ 1$/);
    expect(Object.keys(scan.on)).toContain("workflow_dispatch");
  });

  it("scan.yml checks the two untrusted-input parsers by name", () => {
    expect(scanText).toContain("pdf-parse");
    expect(scanText).toContain("mammoth");
  });
});

describe(".github/CODEOWNERS covers exactly the four paths SRS §12.1 names", () => {
  const owners = read(".github", "CODEOWNERS")
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => line.trim().split(/\s+/));

  it("services/verify.js, prompts/, migrations, and auth middleware", () => {
    const paths = owners.map(([path]) => path);
    expect(paths).toContain("server/src/services/verify.js");
    expect(paths).toContain("server/src/prompts/");
    expect(paths).toContain("server/prisma/migrations/");
    expect(paths).toContain("server/src/middleware/auth.js");
  });

  it("every listed path exists, so a rename cannot silently drop the review rule", () => {
    for (const [path] of owners) expect(existsSync(join(ROOT, path)), path).toBe(true);
  });

  it("every path has an owner", () => {
    for (const [path, owner] of owners) expect(owner, path).toMatch(/^@\S+$/);
  });
});

describe("the secret scan's config", () => {
  const toml = read(".gitleaks.toml");

  it("extends gitleaks' defaults rather than replacing them", () => {
    expect(toml).toMatch(/\[extend\]\s*\nuseDefault\s*=\s*true/);
  });

  it("has an explicit Anthropic rule, on the published prefix", () => {
    expect(toml).toContain('id = "anthropic-api-key-explicit"');
    expect(toml).toContain("sk-ant-");
  });

  it("allowlists literal values only, never a path", () => {
    // A path-level allowlist would hide a real secret pasted into a test
    // file — the case the scan exists to catch.
    const allowlist = toml.slice(toml.indexOf("[allowlist]"));
    expect(allowlist).not.toMatch(/^\s*paths\s*=/m);
    expect(allowlist).toMatch(/regexes\s*=/);
  });
});
