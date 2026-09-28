// Proves .gitleaks.toml (repo root) still does its job, the way
// ops/alerts/run-alert-rule-tests.js proves the alert rules still do
// theirs: by actually running the pinned tool, not by trusting the TOML
// parses (BUILD-PLAN step 70 / SRS §12.1's secret-scan pipeline stage).
//
//   cd server && npm run test:secrets
//
// Two checks, both against the same real gitleaks binary CI uses:
//   1. The tree git actually tracks — `git archive HEAD`, the same content
//      a checkout gives CI, never server/.env or server/.mail-sink (both
//      gitignored) — reports ZERO findings. A regression here means either
//      a real secret has been committed (stop and read the output) or the
//      allowlist has grown too broad and is hiding one.
//   2. A synthetic Anthropic-shaped key, planted in a scratch copy, IS
//      caught. This is the check that exists because gitleaks' OWN bundled
//      anthropic-api-key rule did not reliably catch a synthetic
//      sk-ant-api03-<random> key at several lengths when this was built —
//      found by hand, which is exactly the kind of gap that goes unnoticed
//      again the next time gitleaks changes its bundled rules. This test
//      is what would notice.
//
// Exits 0 when both hold, 1 when either doesn't, 2 when it could not run at
// all (no Docker).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GITLEAKS_IMAGE = "zricethezav/gitleaks:v8.30.1";

/**
 * `--redact -v`: findings print with the secret masked, so a failure here never
 * writes a real credential into CI logs or a terminal.
 *
 * `--no-git`: the scratch directories come from `git archive`, which has no
 * .git of its own, and without it gitleaks scans an empty history and
 * reports "no leaks" having read nothing. The first version of this script
 * omitted it and its "zero findings" check passed vacuously; the planted-key
 * check is what exposed that. CI's own step runs inside a real checkout and
 * scans its history, which is a different mode and the one that is wanted
 * there.
 *
 * @param {string} dir
 */
function runGitleaks(dir) {
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${dir}:/repo`,
      "-w",
      "/repo",
      GITLEAKS_IMAGE,
      "detect",
      "--no-git",
      "--redact",
      "-v",
      "--source=/repo",
      "--config=/repo/.gitleaks.toml",
    ],
    { encoding: "utf8" },
  );
}

/** A base64url-ish random string, structurally like a real Anthropic key's body but not one. */
function syntheticAnthropicKey() {
  const body = randomBytes(72)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `sk-ant-api03-${body}`;
}

async function main() {
  // Check 1: the real, tracked tree.
  const cleanDir = await mkdtemp(join(tmpdir(), "clausecheck-gitleaks-clean-"));
  const negativeDir = await mkdtemp(join(tmpdir(), "clausecheck-gitleaks-planted-"));
  try {
    execFileSync("sh", ["-c", `git archive HEAD | tar -x -C "${cleanDir}"`], {
      cwd: ROOT,
    });
    await writeFile(join(cleanDir, ".gitleaks.toml"), await readConfig());

    const clean = runGitleaks(cleanDir);
    if (clean.error) {
      console.error(
        `could not run gitleaks (is Docker running?): ${clean.error.message}`,
      );
      return 2;
    }
    if (clean.status !== 0) {
      console.error(
        "FAIL: gitleaks found something in the tracked tree. Output:\n" +
          clean.stdout +
          clean.stderr,
      );
      console.error(
        "\nIf this is a real secret, do not commit it — remove it, rotate it at the provider, and re-check.\n" +
          "If this is a new, genuine false positive, .gitleaks.toml's allowlist is the place to narrowly exempt\n" +
          "it — never by widening a path, only by the exact literal value (see that file's own comments).",
      );
      return 1;
    }
    console.log("OK (1/2): the tracked tree reports zero findings.");

    // Check 2: a synthetic key must still be caught.
    execFileSync("sh", ["-c", `git archive HEAD | tar -x -C "${negativeDir}"`], {
      cwd: ROOT,
    });
    await writeFile(join(negativeDir, ".gitleaks.toml"), await readConfig());
    const key = syntheticAnthropicKey();
    await writeFile(
      join(negativeDir, "server", ".env.example"),
      `\nANTHROPIC_API_KEY=${key}\n`,
      { flag: "a" },
    );

    const planted = runGitleaks(negativeDir);
    if (planted.status === 0) {
      console.error(
        "FAIL: a synthetic sk-ant-api03-<random> key was planted and gitleaks did NOT catch it.",
      );
      return 1;
    }
    if (!`${planted.stdout}${planted.stderr}`.includes("anthropic-api-key-explicit")) {
      console.error(
        "FAIL: something fired, but not the expected anthropic-api-key-explicit rule:\n" +
          planted.stdout +
          planted.stderr,
      );
      return 1;
    }
    console.log("OK (2/2): a synthetic Anthropic key is still caught.");

    console.log("\nOK: .gitleaks.toml passes both checks.");
    return 0;
  } finally {
    await rm(cleanDir, { recursive: true, force: true });
    await rm(negativeDir, { recursive: true, force: true });
  }
}

/** The real .gitleaks.toml, read once. */
async function readConfig() {
  const { readFile } = await import("node:fs/promises");
  return readFile(join(ROOT, ".gitleaks.toml"), "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  });
}
