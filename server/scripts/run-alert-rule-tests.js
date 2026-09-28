// Runs the promtool unit tests in ops/alerts/tests/ against
// ops/alerts/alerts.yml (BUILD-PLAN step 68). promtool comes from the
// Prometheus image, so the only prerequisite is Docker — the same
// prerequisite the integration suite already has.
//
//   cd server && npm run test:alerts
//
// It lives under server/ rather than beside the rules it tests for one
// mundane reason: Node resolves node_modules by walking up from the FILE, and
// `yaml` is a server dependency. A copy of the repo's convention — root
// scripts/ avoids importing third-party packages for exactly this reason
// (see scripts/generate-openapi.js).
//
// Exits 0 when every case passes, 1 on a failure, 2 when it could not run at
// all (no Docker). Either non-zero fails CI.
//
// WHY THE RULES ARE COPIED AND STRIPPED FIRST. promtool compares a firing
// alert's ANNOTATIONS as well as its labels, exactly, so every test case
// would have to repeat each rule's summary and description verbatim. That
// makes editing a sentence of operator prose break a PromQL test, which is
// noise rather than signal, and it makes the test files unreadable. So this
// strips `annotations` from a COPY of alerts.yml and runs promtool against
// that: these tests are about expressions, thresholds, `for:` durations and
// labels. The annotations are checked instead by
// server/tests/unit/alertCatalogue.test.js, which is also where they are
// compared with SRS Appendix C — one check per thing.

import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALERTS_DIR = join(HERE, "..", "..", "ops", "alerts");
// Pinned: promtool's test format has changed between major versions, and a
// floating tag would turn an upstream release into a failing build.
const PROMETHEUS_IMAGE = "prom/prometheus:v3.7.3";

/**
 * @param {string} dir
 * @param {string[]} files test files, relative to `dir`
 */
function runPromtool(dir, files) {
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "/bin/promtool",
      "-v",
      `${dir}:/w`,
      "-w",
      "/w",
      PROMETHEUS_IMAGE,
      "test",
      "rules",
      ...files,
    ],
    { encoding: "utf8" },
  );
}

/**
 * The rules with every `annotations` block removed, and a count of how many
 * were removed so a silent no-op cannot pass for a strip.
 *
 * @param {string} yamlText
 */
export function stripAnnotations(yamlText) {
  const document = parse(yamlText);
  let rules = 0;
  let stripped = 0;
  for (const group of document.groups ?? []) {
    for (const rule of group.rules ?? []) {
      rules += 1;
      if (rule.annotations !== undefined) {
        delete rule.annotations;
        stripped += 1;
      }
    }
  }
  return { yaml: stringify(document), rules, stripped };
}

export async function main() {
  const alerts = await readFile(join(ALERTS_DIR, "alerts.yml"), "utf8");
  const { yaml, rules, stripped } = stripAnnotations(alerts);
  if (rules === 0) throw new Error("alerts.yml has no rules — did its shape change?");
  if (stripped !== rules) {
    throw new Error(`${rules - stripped} rule(s) have no annotations; every alert needs a summary and a runbook`);
  }

  const dir = await mkdtemp(join(tmpdir(), "clausecheck-rule-tests-"));
  try {
    await writeFile(join(dir, "alerts.yml"), yaml);
    await mkdir(join(dir, "tests"));
    await cp(join(ALERTS_DIR, "tests"), join(dir, "tests"), { recursive: true });

    const testFiles = (await readdir(join(ALERTS_DIR, "tests")))
      .filter((name) => name.endsWith(".yml"))
      .sort()
      .map((name) => `tests/${name}`);
    if (testFiles.length === 0) throw new Error("ops/alerts/tests has no test files");

    const result = runPromtool(dir, testFiles);
    if (result.error) {
      console.error(`could not run promtool (is Docker running?): ${result.error.message}`);
      return 2;
    }
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    console.log(output.trimEnd());
    if (result.status !== 0) {
      console.error(`\nFAIL: promtool reported failing alert-rule tests (${rules} rules under test).`);
      return 1;
    }
    console.log(`\nOK: ${rules} alert rules pass their promtool unit tests.`);
    return 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  });
}
