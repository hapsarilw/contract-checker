import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
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
    ["deploy-rehearsal", ["ops/deploy/rehearsal/run.sh"]],
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

  it("deploy-rehearsal has the history it builds the previous image from", () => {
    // git archive of the commit before the newest migration: a shallow
    // clone has no such commit, and the rollback half would not run.
    expect(jobs["deploy-rehearsal"].steps[0].with["fetch-depth"]).toBe(0);
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
    // meant to need none. deploy.yml needs some, and has its own, stricter
    // rules below.
    if (file !== "deploy.yml") expect(text).not.toMatch(/secrets\.[A-Z_]+/);
  });

  it.each(["ci.yml", "scan.yml", "deploy.yml"])(
    "%s sets LLM_PROVIDER=mock at the workflow level",
    (file) => {
      const workflow = parse(readFileSync(join(WORKFLOWS, file), "utf8"));
      expect(workflow.env.LLM_PROVIDER).toBe("mock");
    },
  );
});

describe("deploy.yml: SRS §8's procedure, and its secrets kept apart (step 71)", () => {
  const deployText = read(".github", "workflows", "deploy.yml");
  const deploy = parse(deployText);
  const jobs = deploy.jobs;
  /** @param {any} job */
  const commands = (job) => runs(job).join("\n");

  // The only secrets deploy.yml may read. Each is ENVIRONMENT-scoped, so
  // staging and production each have their own; none is a provider key,
  // which lives in the hosting platform's secret store and nowhere else.
  const ALLOWED_SECRETS = [
    "DATABASE_URL",
    "PLATFORM_TOKEN",
    // Step 75: the frontend's host is a different platform from the API's
    // (Netlify and Render), with a token of its own.
    "FRONTEND_PLATFORM_TOKEN",
    "SMOKE_ACCOUNT_PASSWORD",
    "SYNTHETIC_CHECK_TOKEN",
    "PROMETHEUS_TOKEN",
  ];

  it("reads no secret outside its allowed list", () => {
    const used = new Set(
      [...deployText.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]),
    );
    expect([...used].filter((name) => !ALLOWED_SECRETS.includes(name))).toEqual([]);
  });

  it("every job that reads a secret declares an environment, so every secret is per-environment", () => {
    for (const [name, job] of Object.entries(jobs)) {
      if (/secrets\./.test(JSON.stringify(job))) {
        expect(/** @type {any} */ (job).environment, name).toMatch(
          /^(staging|production)$/,
        );
      }
    }
  });

  it("deploys only after CI succeeded on a push to main", () => {
    expect(deploy.on.workflow_run.workflows).toEqual(["CI"]);
    expect(deploy.on.workflow_run.branches).toEqual(["main"]);
    expect(jobs.image.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(jobs.image.if).toContain("github.event.workflow_run.event == 'push'");
  });

  it("builds the image once, tagged by commit, never :latest", () => {
    expect(commands(jobs.image)).toContain("docker push");
    expect(JSON.stringify(deploy)).not.toMatch(/:latest\b/);
    const builds = Object.values(jobs).filter((job) =>
      /docker build/.test(commands(job)),
    );
    expect(builds).toHaveLength(1);
  });

  it("runs migrations as a discrete step, before each environment's deploy", () => {
    for (const env of ["staging", "production"]) {
      expect(commands(jobs[`migrate-${env}`]), env).toContain(
        "npx prisma migrate deploy",
      );
      expect(jobs[`deploy-${env}`].needs, env).toContain(`migrate-${env}`);
      expect(commands(jobs[`deploy-${env}`]), env).not.toContain("migrate");
    }
  });

  it("verifies staging, then waits for approval, before touching production", () => {
    const verify = commands(jobs["verify-staging"]);
    expect(verify).toContain("checks.mjs smoke");
    expect(verify).toContain("checks.mjs long-analysis");
    expect(verify).toContain("e2e/staging.spec.js");
    // TR-24 on every staging deploy (SRS §10.7).
    expect(verify).toContain("e2e/journey.spec.js");
    expect(jobs["migrate-production"].needs).toContain("verify-staging");
    // The first production job is the one the environment's required
    // reviewer gates.
    expect(jobs["migrate-production"].environment).toBe("production");
  });

  it("deploys the frontend after the API, in each environment", () => {
    expect(jobs["frontend-staging"].needs).toContain("deploy-staging");
    expect(jobs["frontend-production"].needs).toContain("deploy-production");
  });

  it("smokes production and then watches it for 15 minutes", () => {
    expect(commands(jobs["deploy-production"])).toContain("checks.mjs smoke");
    expect(commands(jobs["watch-production"])).toContain("checks.mjs watch");
    const step = jobs["watch-production"].steps.find((/** @type {any} */ s) =>
      /watch/.test(s.run ?? ""),
    );
    expect(step.env.WATCH_MINUTES).toBe("15");
  });

  it("rolls the API back by image, with NO migration step", () => {
    const rollback = commands(jobs["rollback-api"]);
    expect(rollback).toContain("deploy-api production");
    expect(rollback).toContain("inputs.rollback_to");
    expect(rollback).not.toMatch(/migrate/);
    expect(rollback).toContain("checks.mjs smoke");
    expect(jobs["rollback-api"].environment).toBe("production");
  });

  it("rolls the frontend back on its own, from that commit's client", () => {
    const job = jobs["rollback-frontend"];
    expect(job.steps[0].with.ref).toBe("${{ inputs.rollback_to }}");
    expect(commands(job)).toContain("deploy-frontend production");
    expect(commands(job)).not.toContain("deploy-api");
  });

  it("scripts/deploy/platform.sh fails loudly until a platform is chosen", () => {
    // A deploy that "succeeds" without deploying anything is the worst
    // failure this pipeline could have. DEPLOY_PLATFORM is unset here, as it
    // is in every environment until the owner picks one.
    const script = join(ROOT, "scripts", "deploy", "platform.sh");
    const unchosen = spawnSync("bash", [script, "deploy-api", "staging", "img:sha"], {
      encoding: "utf8",
    });
    expect(unchosen.status).toBe(1);
    expect(unchosen.stderr).toContain("No hosting platform has been chosen");
    const badEnv = spawnSync("bash", [script, "deploy-api", "prod", "img:sha"], {
      encoding: "utf8",
    });
    expect(badEnv.status).toBe(2);
  });

  describe("scripts/deploy/platform.sh's Render and Netlify cases (step 75), against a fake API", () => {
    const script = join(ROOT, "scripts", "deploy", "platform.sh");
    const fake = join(ROOT, "server", "tests", "fixtures", "deploy", "fake-curl.sh");
    /** @param {string[]} args @param {Record<string, string>} env */
    const runPlatform = (args, env) => {
      const dir = mkdtempSync(join(tmpdir(), "platform-"));
      const log = join(dir, "curl.log");
      const result = spawnSync("bash", [script, ...args], {
        encoding: "utf8",
        env: {
          // The child needs the runner's PATH to find bash, jq and zip; this
          // is not the application's configuration.
          // eslint-disable-next-line no-restricted-syntax -- see above
          PATH: process.env.PATH ?? "",
          CURL: fake,
          FAKE_CURL_LOG: log,
          FAKE_CURL_COUNTER: join(dir, "counter"),
          POLL_INTERVAL_SECONDS: "0",
          ...env,
        },
      });
      const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
      rmSync(dir, { recursive: true, force: true });
      return { ...result, calls };
    };
    const render = {
      DEPLOY_PLATFORM: "render",
      PLATFORM_TOKEN: "rnd_test",
      RENDER_SERVICE_ID: "srv-test",
    };

    it("Render: deploys exactly that image and waits until the deploy is live", () => {
      const r = runPlatform(["deploy-api", "staging", "ghcr.io/x/server:abc123"], {
        ...render,
        FAKE_STATES: "created,update_in_progress,live",
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.calls[0]).toContain("https://api.render.com/v1/services/srv-test/deploys");
      expect(r.calls[0]).toContain('"imageUrl": "ghcr.io/x/server:abc123"');
      expect(r.calls[0]).toContain("Authorization: Bearer rnd_test");
      expect(r.calls).toHaveLength(4);
      expect(r.stdout).toContain("live");
    });

    it("Render: a failed update fails the job, and does not wait out the timeout", () => {
      const r = runPlatform(["deploy-api", "production", "img:sha"], {
        ...render,
        FAKE_STATES: "update_in_progress,update_failed",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("ended update_failed");
    });

    it("Render: a deploy that never finishes fails at the timeout", () => {
      const r = runPlatform(["deploy-api", "staging", "img:sha"], {
        ...render,
        FAKE_STATES: "update_in_progress",
        POLL_TIMEOUT_SECONDS: "0",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("did not finish");
    });

    it("Render: a missing service id is refused before any request", () => {
      const r = runPlatform(["deploy-api", "staging", "img:sha"], {
        DEPLOY_PLATFORM: "render",
        PLATFORM_TOKEN: "rnd_test",
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("RENDER_SERVICE_ID is not set");
      expect(r.calls).toEqual([]);
    });

    it("Netlify: uploads the directory as a zip and waits until the deploy is ready", () => {
      const dist = mkdtempSync(join(tmpdir(), "dist-"));
      writeFileSync(join(dist, "index.html"), "<!doctype html>");
      const r = runPlatform(["deploy-frontend", "staging", dist], {
        FRONTEND_PLATFORM: "netlify",
        FRONTEND_PLATFORM_TOKEN: "nfp_test",
        NETLIFY_SITE_ID: "site-test",
        FAKE_KEY: "state",
        FAKE_STATES: "uploading,processing,ready",
      });
      rmSync(dist, { recursive: true, force: true });
      expect(r.status, r.stderr).toBe(0);
      expect(r.calls[0]).toContain(
        "https://api.netlify.com/api/v1/sites/site-test/deploys",
      );
      expect(r.calls[0]).toContain("Content-Type: application/zip");
      expect(r.calls).toHaveLength(4);
    });

    it("the frontend fails loudly with no platform, like the API", () => {
      const r = runPlatform(["deploy-frontend", "staging", "client/dist"], {});
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("No hosting platform has been chosen for the frontend");
    });

    it("the workflow passes each platform its own token and ids", () => {
      for (const job of ["deploy-staging", "deploy-production"]) {
        const step = jobs[job].steps.find((/** @type {any} */ x) =>
          /deploy-api/.test(x.run ?? ""),
        );
        expect(Object.keys(step.env).sort(), job).toEqual(
          ["DEPLOY_PLATFORM", "PLATFORM_TOKEN", "RENDER_SERVICE_ID"].sort(),
        );
      }
      for (const job of ["frontend-staging", "frontend-production"]) {
        const step = jobs[job].steps.find((/** @type {any} */ x) =>
          /deploy-frontend/.test(x.run ?? ""),
        );
        expect(Object.keys(step.env).sort(), job).toEqual(
          ["FRONTEND_PLATFORM", "FRONTEND_PLATFORM_TOKEN", "NETLIFY_SITE_ID"].sort(),
        );
      }
    });
  });

  it("a clean `npm ci` generates the Prisma client (Prisma 7 no longer does)", () => {
    // Step 75: the benchmark workflow failed on a clean runner with "does not
    // provide an export named 'PrismaClient'", and so would every CI job that
    // imports the app. Locally, node_modules held an old generated client.
    const pkg = JSON.parse(readFileSync(join(ROOT, "server", "package.json"), "utf8"));
    expect(pkg.scripts.postinstall).toBe("node scripts/generate-prisma-client.js");
    // The Dockerfile runs `npm ci` before copying the source, so the script
    // must already be in the build context at that point.
    const dockerfile = readFileSync(join(ROOT, "server", "Dockerfile"), "utf8");
    const copied = dockerfile.indexOf("COPY scripts/generate-prisma-client.js");
    expect(copied).toBeGreaterThan(-1);
    expect(copied).toBeLessThan(dockerfile.indexOf("RUN npm ci"));
  });

  it("the client generator skips, and succeeds, where there is no schema yet (the Dockerfile's npm ci)", () => {
    const dir = mkdtempSync(join(tmpdir(), "generate-client-"));
    mkdirSync(join(dir, "scripts"));
    copyFileSync(
      join(ROOT, "server", "scripts", "generate-prisma-client.js"),
      join(dir, "scripts", "generate-prisma-client.js"),
    );
    const run = spawnSync(
      process.execPath,
      [join(dir, "scripts", "generate-prisma-client.js")],
      {
        encoding: "utf8",
      },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("skipped");
  });

  it("the runtime image ships the operator CLI the runbooks run on the platform, and no other script", () => {
    // Step 75: every runbook says "npm run ops -- <command> from a shell on
    // the platform", and scripts/ops.js was not in the image.
    const dockerfile = readFileSync(join(ROOT, "server", "Dockerfile"), "utf8");
    const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    expect(runtime).toMatch(/^COPY scripts\/ops\.js \.\/scripts\/ops\.js$/m);
    expect(runtime).not.toMatch(/^COPY scripts(\/)? /m);
    // ops.js may import only what the image has: src/ and Node's own modules.
    const imports = [
      ...readFileSync(join(ROOT, "server", "scripts", "ops.js"), "utf8").matchAll(
        /from "([^"]+)"/g,
      ),
    ].map((m) => m[1]);
    expect(
      imports.filter((x) => !x.startsWith("../src/") && !x.startsWith("node:")),
    ).toEqual([]);
  });

  it("never cancels a deploy half-way", () => {
    expect(deploy.concurrency).toEqual({ group: "deploy", "cancel-in-progress": false });
  });
});

describe("no workflow uses an action major that runs on Node 20 (step 75)", () => {
  // GitHub deprecated Node 20 for actions and forces them onto Node 24; the
  // first benchmark run in CI warned about checkout, setup-node and
  // upload-artifact at v4. These are the first majors whose runtime is
  // node24 (each one's release notes, read 2026-10-12).
  const FIRST_NODE24_MAJOR = {
    "actions/checkout": 5,
    "actions/setup-node": 5,
    "actions/upload-artifact": 6,
    "actions/download-artifact": 7,
  };
  const dir = join(ROOT, ".github", "workflows");
  const uses = readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .flatMap((f) =>
      [
        ...readFileSync(join(dir, f), "utf8").matchAll(
          /uses: (actions\/[a-z-]+)@v(\d+)/g,
        ),
      ].map((m) => ({ file: f, action: m[1], major: Number(m[2]) })),
    );

  it("finds the actions it is checking", () => {
    expect(uses.length).toBeGreaterThan(20);
  });

  it("every one is at or above its first Node 24 major", () => {
    const old = uses.filter(
      (u) =>
        u.action in FIRST_NODE24_MAJOR &&
        u.major <
          FIRST_NODE24_MAJOR[/** @type {keyof typeof FIRST_NODE24_MAJOR} */ (u.action)],
    );
    expect(old.map((u) => `${u.file}: ${u.action}@v${u.major}`)).toEqual([]);
  });

  it("upload and download artifact share the v4+ backend, so a v7 upload is readable by a v8 download", () => {
    const majors = uses.filter((u) => /-artifact$/.test(u.action)).map((u) => u.major);
    expect(Math.min(...majors)).toBeGreaterThanOrEqual(4);
  });
});

describe("benchmark.yml: the one workflow with a provider key (step 72)", () => {
  const text = read(".github", "workflows", "benchmark.yml");
  const workflow = parse(text);
  const job = workflow.jobs.benchmark;
  const parsed = JSON.stringify(workflow);

  it("never runs from a fork: pull_request only, and the job refuses a fork's", () => {
    expect(Object.keys(workflow.on)).toContain("pull_request");
    expect(parsed).not.toContain("pull_request_target");
    expect(job.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  it("puts a pull request's run behind the approval environment", () => {
    expect(job.environment).toBe(
      "${{ github.event_name == 'pull_request' && 'benchmark-pr' || 'benchmark' }}",
    );
  });

  it("reads exactly one secret, its own key, in the one step that needs it", () => {
    expect([...parsed.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1])).toEqual([
      "ANTHROPIC_BENCHMARK_KEY",
    ]);
    const holders = job.steps.filter((/** @type {any} */ s) =>
      /secrets\./.test(JSON.stringify(s.env ?? {})),
    );
    expect(holders).toHaveLength(1);
    expect(holders[0].run).toContain("scripts/benchmark.js");
    expect(JSON.stringify(job.env)).not.toMatch(/secrets\./);
  });

  it("a missing key fails with what to set and where, before the benchmark starts", () => {
    const step = job.steps.find((/** @type {any} */ s) =>
      /scripts\/benchmark\.js/.test(s.run ?? ""),
    );
    const script = step.run.replace(/\$\{\{[^}]*\}\}/g, "benchmark");
    const run = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      // eslint-disable-next-line no-restricted-syntax -- the shell needs PATH to find its builtins' helpers; nothing of the app's
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "" },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("::error title=ANTHROPIC_BENCHMARK_KEY is not set::");
    expect(run.stdout).toContain("'benchmark' environment");
    // It stops there: the benchmark itself never ran.
    expect(run.stderr).not.toContain("refusing to boot");
  });

  it("measures the real model, not the mock", () => {
    expect(job.env.LLM_PROVIDER).toBe("anthropic");
  });

  it("pins a model config.js knows, at the price benchmark.js reports with", () => {
    expect(read("server", "src", "config.js")).toContain(`"${job.env.ANTHROPIC_MODEL}":`);
    const bench = read("scripts", "benchmark.js");
    const price = new RegExp(
      `"${job.env.ANTHROPIC_MODEL}": \\{ input: (\\d+(?:\\.\\d+)?), output: (\\d+(?:\\.\\d+)?) \\}`,
    ).exec(bench);
    expect(price, "benchmark.js PRICING has the pinned model").not.toBeNull();
    expect(job.env.LLM_PRICE_INPUT_PER_MTOK).toBe(price?.[1]);
    expect(job.env.LLM_PRICE_OUTPUT_PER_MTOK).toBe(price?.[2]);
  });

  it("triggers on SRS §10.4's paths, the same for pushes and pull requests, and weekly", () => {
    const paths = workflow.on.push.paths;
    expect(workflow.on.pull_request.paths).toEqual(paths);
    for (const required of [
      "server/src/prompts/**",
      "server/src/schemas/**",
      "server/src/services/verify.js",
      "server/src/services/risk.js",
      // ANTHROPIC_MODEL is pinned in this file, so a model change edits it.
      ".github/workflows/benchmark.yml",
    ]) {
      expect(paths).toContain(required);
    }
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.schedule[0].cron).toMatch(/^\S+ \S+ \S+ \S+ 1$/);
  });

  it("never commits: read-only token, no git writes, the row goes to an artifact", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
    expect(parsed).not.toMatch(/git (push|commit)/);
    const run = job.steps.find((/** @type {any} */ s) =>
      /scripts\/benchmark\.js/.test(s.run ?? ""),
    ).run;
    expect(run).toContain("--history-out");
  });
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
