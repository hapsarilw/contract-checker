// FR-7.13, the half the bundle check does not cover: "Largest Contentful
// Paint ≤ 2.5 s on a simulated mid-tier mobile device over 4G." SRS §10.5
// lists only the bundle check as a gate, so without this the LCP target
// would ship unverified (BUILD-PLAN step 66).
//
//   npm run perf:lcp
//
// Exits 1 if any page's median LCP is over budget, 2 if it could not
// measure at all. Either one fails CI.
//
// WHAT "SIMULATED MID-TIER MOBILE OVER 4G" MEANS HERE: Lighthouse's own
// default mobile configuration, unchanged. That is a Moto G Power class
// device (4x CPU slowdown) on "slow 4G" (150 ms RTT, 1.6 Mbps down), with
// throttling SIMULATED from a trace rather than applied live. Simulation
// is the right choice for a gate: live throttling on a shared CI runner
// measures the runner as much as the app. The config is deliberately not
// tuned; a budget measured on a friendlier device than the spec names is
// a budget that has been quietly lowered.
//
// WHAT IS MEASURED: a production build, served by Vite's preview server,
// talking to a small local mock of the API (./perf/mock-api.mjs) that
// returns realistic content. Three pages: /login (a first visit), /
// (the upload screen, where a signed-in person lands) and /documents/doc1
// (the report, the heaviest screen, PRD §2.2's reason for this budget).
// Without the mock, every signed-in page would redirect to /login and
// the report would never be measured.
//
// Each page runs RUNS times and the MEDIAN is compared with the budget:
// one Lighthouse run is noisy enough to flip a gate on its own.
//
// The budget is a constant, not an environment variable, on purpose. A
// gate that can be loosened by setting a variable in CI will be.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { chromium } from "@playwright/test";
import { startMockApi } from "./perf/mock-api.mjs";

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(CLIENT_DIR, ".perf-build");
const LCP_BUDGET_MS = 2500;
const RUNS = 3;
const API_PORT = 3999;
const PREVIEW_PORT = 4179;
const PAGES = ["/login", "/", "/documents/doc1"];

/**
 * Which element was the LCP, for whoever has to make it faster.
 * @param {Record<string, any> | undefined} audits
 */
function lcpElementOf(audits) {
  const items = audits?.["largest-contentful-paint-element"]?.details?.items ?? [];
  for (const item of items) {
    const node = item?.items?.[0]?.node ?? item?.node;
    if (node?.snippet) return String(node.snippet).slice(0, 90);
  }
  return "unknown";
}

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * One Lighthouse run. A failed TRACE (Lighthouse's runtimeError, e.g.
 * NO_NAVSTART, seen on a cold first run) is retried once, because it is a
 * failure to measure, not a measurement. A slow page is never retried:
 * retrying until a run comes in under budget would make the gate a
 * lottery.
 *
 * @param {string} url
 * @param {number} port
 */
async function audit(url, port) {
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    result = await lighthouse(url, {
      port,
      onlyCategories: ["performance"],
      logLevel: "error",
      output: "json",
    });
    if (!result?.lhr.runtimeError) return result;
  }
  return result;
}

async function main() {
  const origin = `http://localhost:${PREVIEW_PORT}`;
  const api = await startMockApi({ port: API_PORT, allowOrigin: origin });

  // A build of its own, so the API base URL can point at the mock and
  // the normal dist/ (which bundle:check reads) is left alone.
  process.env.VITE_API_BASE_URL = `http://localhost:${API_PORT}`;
  await build({
    root: CLIENT_DIR,
    logLevel: "warn",
    build: { outDir: join(OUT_DIR, "dist"), emptyOutDir: true },
  });
  const server = await preview({
    root: CLIENT_DIR,
    logLevel: "warn",
    build: { outDir: join(OUT_DIR, "dist") },
    preview: { port: PREVIEW_PORT, strictPort: true },
  });

  // Playwright's Chromium, which the E2E suite already installs, so CI
  // needs no second browser.
  const chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ["--headless=new", "--no-sandbox"],
  });

  /** @type {{ page: string, lcpMs: number[], medianMs: number, fcpMs: number, cls: number, tbtMs: number, lcpElement: string }[]} */
  const results = [];
  try {
    for (const page of PAGES) {
      /** @type {number[]} */
      const lcps = [];
      let last;
      for (let run = 0; run < RUNS; run += 1) {
        const result = await audit(`${origin}${page}`, chrome.port);
        const audits = result?.lhr.audits;
        const lcp = audits?.["largest-contentful-paint"]?.numericValue;
        if (typeof lcp !== "number") {
          const warning = result?.lhr.runtimeError?.message ?? "no LCP was recorded";
          throw new Error(`${page}: ${warning}`);
        }
        lcps.push(lcp);
        last = audits;
      }
      results.push({
        page,
        lcpMs: lcps.map(Math.round),
        medianMs: Math.round(median(lcps)),
        fcpMs: Math.round(last?.["first-contentful-paint"]?.numericValue ?? NaN),
        cls: Number((last?.["cumulative-layout-shift"]?.numericValue ?? NaN).toFixed(3)),
        tbtMs: Math.round(last?.["total-blocking-time"]?.numericValue ?? NaN),
        lcpElement: lcpElementOf(last),
      });
    }
  } finally {
    await chrome.kill();
    await new Promise((resolve) => server.httpServer.close(resolve));
    await api.close();
  }

  console.log(
    `LCP, Lighthouse ${"mobile"} (simulated slow 4G, 4x CPU), median of ${RUNS}; budget ${LCP_BUDGET_MS} ms\n`,
  );
  for (const r of results) {
    const verdict = r.medianMs <= LCP_BUDGET_MS ? "ok  " : "OVER";
    console.log(
      `  ${verdict} ${r.page.padEnd(16)} LCP ${String(r.medianMs).padStart(5)} ms  (runs ${r.lcpMs.join(", ")})   FCP ${r.fcpMs} ms  TBT ${r.tbtMs} ms  CLS ${r.cls}\n         LCP element: ${r.lcpElement}`,
    );
  }
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    join(OUT_DIR, "lcp-report.json"),
    JSON.stringify({ budgetMs: LCP_BUDGET_MS, runs: RUNS, results }, null, 2),
  );

  const over = results.filter((r) => r.medianMs > LCP_BUDGET_MS);
  if (over.length > 0) {
    console.error(
      `\nFAIL: ${over.map((r) => r.page).join(", ")} over the FR-7.13 LCP budget of ${LCP_BUDGET_MS} ms.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("\nOK: every page within the FR-7.13 LCP budget.");
}

main().catch((err) => {
  console.error(`Could not measure LCP: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 2;
});
