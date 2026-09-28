// BUILD-PLAN step 71 (OPS-8): the checks a deploy runs against a live
// environment. Dependency-free (Node's own fetch), so the same file runs
// from .github/workflows/deploy.yml, from a laptop against staging, and
// against the local rehearsal stack (ops/deploy/rehearsal).
//
//   node ops/deploy/checks.mjs smoke          SRS §8's post-deploy smoke
//   node ops/deploy/checks.mjs long-analysis  FR-3.7's timeout chain, for real
//   node ops/deploy/checks.mjs watch          the 15-minute watch
//
// Environment:
//   DEPLOY_BASE_URL          the API's public origin, e.g. https://api-staging.example.com
//   SMOKE_ACCOUNT_EMAIL      a synthetic account in THAT environment (never a real user's)
//   SMOKE_ACCOUNT_PASSWORD
//   DEPLOY_EXPECTED_SHA      smoke/watch: the git SHA every instance must report
//   SYNTHETIC_CHECK_TOKEN    optional; only useful from an allowlisted address
//   LONG_ANALYSIS_MIN_SECONDS  default 50
//   WATCH_MINUTES            default 15
//   PROMETHEUS_URL           watch: optional; query api_5xx_rate's own ratio too
//   PROMETHEUS_TOKEN         optional bearer token for it
//
// Prints statuses, timings and SHAs only: never a password, a cookie, a
// token or a byte of document text. Exit codes: 0 pass, 1 fail, 2 could not
// run (missing configuration), 3 inconclusive (long-analysis only: the
// analysis finished, but too quickly to prove anything about the proxy).

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "../synthetics/login-list.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STEP_TIMEOUT_MS = 10_000;
// Longer than every link of the chain it is testing (proxy > 120 s server
// timeout > 90 s ceiling > 60 s LLM), so if the request is cut, something
// between here and the process cut it — never this client.
const LONG_ANALYSIS_CLIENT_TIMEOUT_MS = 200_000;
// FR-2.6's Phase 1 cap. The long-analysis document stays under it.
const WORD_CAP = 4_000;
// Rolling deploys run old and new side by side; one read of /api/version
// reaches one instance. Enough reads that an instance still on the old SHA
// behind a round-robin balancer of up to ~4 would almost surely be hit.
export const VERSION_SAMPLES = 12;
// api_5xx_rate's own threshold (ops/alerts/alerts.yml), so the watch fails
// no later than the pager would, over a window short enough to be about
// the new release rather than the traffic before it.
export const ERROR_RATIO_THRESHOLD = 0.02;
export const ERROR_RATIO_QUERY =
  'sum(rate(http_request_duration_seconds_count{status=~"5.."}[5m])) / sum(rate(http_request_duration_seconds_count[5m]))';

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every instance reports the expected SHA. A mismatch on any sample fails:
 * after a deploy is declared done, an instance still serving the previous
 * image is exactly what a "done" rolling deploy must not leave behind.
 *
 * @param {{ baseUrl: string, expectedSha: string, samples?: number, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, seen: Record<string, number>, reason?: string }>}
 */
export async function checkVersion({
  baseUrl,
  expectedSha,
  samples = VERSION_SAMPLES,
  fetchImpl = fetch,
}) {
  /** @type {Record<string, number>} */
  const seen = {};
  for (let i = 0; i < samples; i += 1) {
    let sha = "(error)";
    try {
      const res = await fetchImpl(`${baseUrl}/api/version`, {
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      });
      const body = /** @type {{ gitSha?: unknown } | null} */ (
        await res.json().catch(() => null)
      );
      sha =
        res.status === 200 && typeof body?.gitSha === "string"
          ? body.gitSha
          : `(status ${res.status})`;
    } catch {
      // counted below as "(error)"
    }
    seen[sha] = (seen[sha] ?? 0) + 1;
  }
  const others = Object.keys(seen).filter((sha) => sha !== expectedSha);
  return others.length === 0
    ? { ok: true, seen }
    : {
        ok: false,
        seen,
        reason: `expected every instance on ${expectedSha}, saw ${others.join(", ")}`,
      };
}

/**
 * SRS §8 / BUILD-PLAN step 71: /api/version (every instance, the expected
 * SHA), /api/ready, and one authenticated round trip. The round trip is the
 * synthetic check's own (ops/synthetics/login-list.mjs), so "the smoke
 * check passed" and "the synthetic check passes" mean the same thing.
 *
 * @param {{ baseUrl: string, expectedSha: string, email: string, password: string, checkToken?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, lines: string[] }>}
 */
export async function smoke({
  baseUrl,
  expectedSha,
  email,
  password,
  checkToken = "",
  fetchImpl = fetch,
}) {
  const lines = [];
  const version = await checkVersion({ baseUrl, expectedSha, fetchImpl });
  lines.push(
    `${version.ok ? "ok  " : "FAIL"} version  ${JSON.stringify(version.seen)}${version.reason ? `  (${version.reason})` : ""}`,
  );

  let readyOk = false;
  try {
    const res = await fetchImpl(`${baseUrl}/api/ready`, {
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    readyOk = res.status === 200;
    lines.push(`${readyOk ? "ok  " : "FAIL"} ready    ${res.status}`);
  } catch (err) {
    lines.push(
      `FAIL ready    -  (${err instanceof Error ? err.name : "error"})`,
    );
  }

  const roundTrip = await runCheck({
    baseUrl,
    email,
    password,
    checkToken,
    fetchImpl,
  });
  for (const s of roundTrip.steps) {
    lines.push(
      `${s.ok ? "ok  " : "FAIL"} ${s.step.padEnd(8)} ${String(s.status ?? "-")} ${s.ms} ms${s.reason ? `  (${s.reason})` : ""}`,
    );
  }
  return { ok: version.ok && readyOk && roundTrip.ok, lines };
}

/**
 * The longest document the product will analyse: fixture 05's synthetic MSA
 * cut at a paragraph boundary to stay under FR-2.6's cap. On a real
 * provider a longer document is a longer analysis, so this is the one most
 * likely to reach the 50 s FR-3.7 asks for. Synthetic by construction —
 * SRS §2.3 allows nothing else in staging.
 *
 * @param {string} text
 * @param {number} [cap]
 */
export function longestPermittedDocument(text, cap = WORD_CAP - 50) {
  const kept = [];
  let words = 0;
  for (const paragraph of text.split(/\n\s*\n/)) {
    const count = paragraph.split(/\s+/).filter(Boolean).length;
    if (words + count > cap) break;
    kept.push(paragraph);
    words += count;
  }
  return { text: kept.join("\n\n"), words };
}

/**
 * @param {{ baseUrl: string, email: string, password: string, checkToken?: string, fetchImpl: typeof fetch }} options
 * @returns {Promise<string>} the session cookie, name=value pairs only
 */
async function login({ baseUrl, email, password, checkToken = "", fetchImpl }) {
  const res = await fetchImpl(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Synthetic-Check": checkToken,
    },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`login answered ${res.status}`);
  return (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""])
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

/**
 * FR-3.7, verified rather than assumed: one real analysis request, through
 * whatever sits in front of the API, held open for at least `minSeconds`.
 *
 *   pass          200 after >= minSeconds: every layer between here and the
 *                 process let a request of that length through.
 *   fail          the request was cut, or answered with anything but 200.
 *                 The elapsed time is the clue: a cut at ~30 s or ~60 s is a
 *                 proxy or balancer default, not this application.
 *   inconclusive  200, but faster than minSeconds, so the chain was never
 *                 stretched. On a real provider the document decides the
 *                 duration; see docs/deployment.md for what to do then.
 *
 * The document is deleted afterwards either way (staging keeps nothing it
 * does not need, SRS §2.3).
 *
 * @param {{ baseUrl: string, email: string, password: string, checkToken?: string, minSeconds?: number, document: string, fetchImpl?: typeof fetch, now?: () => number }} options
 * @returns {Promise<{ verdict: "pass" | "fail" | "inconclusive", seconds: number | null, status: number | null, reason: string }>}
 */
export async function longAnalysis({
  baseUrl,
  email,
  password,
  checkToken = "",
  minSeconds = 50,
  document,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const cookie = await login({
    baseUrl,
    email,
    password,
    checkToken,
    fetchImpl,
  });
  const created = await fetchImpl(`${baseUrl}/api/v1/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ text: document }),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS * 3),
  });
  if (created.status !== 201) {
    return {
      verdict: "fail",
      seconds: null,
      status: created.status,
      reason: `upload answered ${created.status}, not 201`,
    };
  }
  const { document: doc } = /** @type {{ document: { id: string } }} */ (
    await created.json()
  );

  const started = now();
  /** @type {{ verdict: "pass" | "fail" | "inconclusive", seconds: number | null, status: number | null, reason: string }} */
  let result;
  try {
    const res = await fetchImpl(
      `${baseUrl}/api/v1/documents/${doc.id}/analyze`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: "{}",
        signal: AbortSignal.timeout(LONG_ANALYSIS_CLIENT_TIMEOUT_MS),
      },
    );
    await res.arrayBuffer().catch(() => undefined);
    const seconds = (now() - started) / 1000;
    if (res.status !== 200) {
      result = {
        verdict: "fail",
        seconds,
        status: res.status,
        reason:
          // Different causes, different places to look. Found by breaking the
          // rehearsal's stop grace period on purpose: a killed instance came
          // back as 502, and this used to blame the proxy's timeout for it.
          res.status === 504
            ? `a proxy answered 504 after ${seconds.toFixed(1)} s: its timeout is below the server's 120 s`
            : res.status === 502
              ? `a proxy answered 502 after ${seconds.toFixed(1)} s: the instance serving the request went away mid-request (killed before its 90 s drain finished, or crashed); check the platform's stop grace period`
              : `analyze answered ${res.status} after ${seconds.toFixed(1)} s`,
      };
    } else if (seconds < minSeconds) {
      result = {
        verdict: "inconclusive",
        seconds,
        status: 200,
        reason: `completed in ${seconds.toFixed(1)} s, under the ${minSeconds} s this check needs to prove anything about the proxy`,
      };
    } else {
      result = {
        verdict: "pass",
        seconds,
        status: 200,
        reason: `a ${seconds.toFixed(1)} s analysis completed through the proxy`,
      };
    }
  } catch (err) {
    const seconds = (now() - started) / 1000;
    const cause = /** @type {{ cause?: { code?: string } }} */ (err)?.cause
      ?.code;
    result = {
      verdict: "fail",
      seconds,
      status: null,
      reason: `the connection was closed after ${seconds.toFixed(1)} s${cause ? ` (${cause})` : ""}: something between this client and the API cut the request`,
    };
  }

  await fetchImpl(`${baseUrl}/api/v1/documents/${doc.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  }).catch(() => undefined);
  return result;
}

/**
 * The 5xx ratio api_5xx_rate pages on, read from Prometheus. `null` when
 * there was no traffic to divide by (0/0), which is not a failure.
 *
 * @param {{ prometheusUrl: string, token?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<number | null>}
 */
export async function errorRatio({ prometheusUrl, token, fetchImpl = fetch }) {
  const url = `${prometheusUrl.replace(/\/$/, "")}/api/v1/query?query=${encodeURIComponent(ERROR_RATIO_QUERY)}`;
  const res = await fetchImpl(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`Prometheus answered ${res.status}`);
  const body =
    /** @type {{ data?: { result?: { value?: [number, string] }[] } }} */ (
      await res.json()
    );
  const value = body.data?.result?.[0]?.value?.[1];
  if (value === undefined) return null;
  const ratio = Number(value);
  return Number.isFinite(ratio) ? ratio : null;
}

/**
 * SRS §8's "watch the error rate for 15 minutes". Every interval: the smoke
 * check (so the watch sees what a user sees, instance SHAs included), and,
 * when Prometheus is configured, the fleet's 5xx ratio against
 * api_5xx_rate's own threshold. One failed probe is tolerated as a blip;
 * a second one fails the watch, and so does any ratio above threshold.
 *
 * @param {{ probe: () => Promise<{ ok: boolean, lines: string[] }>, ratio?: () => Promise<number | null>, minutes?: number, intervalMs?: number, sleepImpl?: (ms: number) => Promise<void>, log?: (line: string) => void }} options
 * @returns {Promise<{ ok: boolean, failedProbes: number, worstRatio: number | null, reason?: string }>}
 */
export async function watch({
  probe,
  ratio,
  minutes = 15,
  intervalMs = 60_000,
  sleepImpl = sleep,
  log = console.log,
}) {
  const rounds = Math.max(1, Math.round((minutes * 60_000) / intervalMs));
  let failedProbes = 0;
  /** @type {number | null} */
  let worstRatio = null;
  for (let round = 1; round <= rounds; round += 1) {
    const result = await probe();
    if (!result.ok) {
      failedProbes += 1;
      for (const line of result.lines) log(`  ${line}`);
    }
    let ratioText = "";
    if (ratio) {
      const value = await ratio().catch((err) => {
        log(`  prometheus: ${err instanceof Error ? err.message : "error"}`);
        return null;
      });
      if (value !== null) worstRatio = Math.max(worstRatio ?? 0, value);
      ratioText =
        value === null
          ? "  5xx ratio: no data"
          : `  5xx ratio: ${(value * 100).toFixed(2)}%`;
      if (value !== null && value > ERROR_RATIO_THRESHOLD) {
        log(`round ${round}/${rounds}: FAIL${ratioText}`);
        return {
          ok: false,
          failedProbes,
          worstRatio,
          reason: `5xx ratio ${(value * 100).toFixed(2)}% is above api_5xx_rate's ${ERROR_RATIO_THRESHOLD * 100}%`,
        };
      }
    }
    log(
      `round ${round}/${rounds}: ${result.ok ? "ok" : "probe FAILED"}${ratioText}`,
    );
    if (failedProbes >= 2) {
      return {
        ok: false,
        failedProbes,
        worstRatio,
        reason: `${failedProbes} probes failed; one is a blip, two is the release`,
      };
    }
    if (round < rounds) await sleepImpl(intervalMs);
  }
  return { ok: true, failedProbes, worstRatio };
}

async function main() {
  const [command] = process.argv.slice(2);
  const env = process.env;
  const need = (/** @type {string[]} */ ...names) => {
    const missing = names.filter((name) => !env[name]);
    if (missing.length > 0) {
      console.error(`missing: ${missing.join(", ")}`);
      process.exit(2);
    }
  };
  need("DEPLOY_BASE_URL", "SMOKE_ACCOUNT_EMAIL", "SMOKE_ACCOUNT_PASSWORD");
  const common = {
    baseUrl: /** @type {string} */ (env.DEPLOY_BASE_URL).replace(/\/$/, ""),
    email: /** @type {string} */ (env.SMOKE_ACCOUNT_EMAIL),
    password: /** @type {string} */ (env.SMOKE_ACCOUNT_PASSWORD),
    checkToken: env.SYNTHETIC_CHECK_TOKEN ?? "",
  };

  if (command === "smoke" || command === "watch") {
    need("DEPLOY_EXPECTED_SHA");
    const probe = () =>
      smoke({
        ...common,
        expectedSha: /** @type {string} */ (env.DEPLOY_EXPECTED_SHA),
      });
    if (command === "smoke") {
      const result = await probe();
      for (const line of result.lines) console.log(line);
      return result.ok ? 0 : 1;
    }
    const prometheusUrl = env.PROMETHEUS_URL;
    if (!prometheusUrl)
      console.log(
        "PROMETHEUS_URL unset: watching the smoke check only, not the fleet's 5xx ratio",
      );
    const result = await watch({
      probe,
      ratio: prometheusUrl
        ? () => errorRatio({ prometheusUrl, token: env.PROMETHEUS_TOKEN })
        : undefined,
      minutes: Number(env.WATCH_MINUTES ?? 15),
    });
    console.log(result.ok ? "OK: the watch passed" : `FAIL: ${result.reason}`);
    return result.ok ? 0 : 1;
  }

  if (command === "long-analysis") {
    const source = await readFile(
      join(
        HERE,
        "..",
        "..",
        "server",
        "tests",
        "fixtures",
        "05-oversized-msa.txt",
      ),
      "utf8",
    );
    const { text, words } = longestPermittedDocument(source);
    const minSeconds = Number(env.LONG_ANALYSIS_MIN_SECONDS ?? 50);
    console.log(
      `analysing a ${words}-word synthetic contract; needs >= ${minSeconds} s to count`,
    );
    const result = await longAnalysis({
      ...common,
      minSeconds,
      document: text,
    });
    console.log(`${result.verdict.toUpperCase()}: ${result.reason}`);
    return { pass: 0, fail: 1, inconclusive: 3 }[result.verdict];
  }

  console.error(
    "usage: node ops/deploy/checks.mjs smoke | long-analysis | watch",
  );
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
