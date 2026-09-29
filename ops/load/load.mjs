// BUILD-PLAN step 73 (OPS-10): the load, soak and upload-flood runs, SRS
// §10.6's TR-21, TR-22 and TR-23. Dependency-free (Node's fetch), like
// ops/deploy/checks.mjs.
//
//   node ops/load/load.mjs tr21 --sessions FILE [--minutes 10] [--concurrency 20]
//   node ops/load/load.mjs tr22 --sessions FILE [--minutes 120] [--concurrency 5]
//   node ops/load/load.mjs tr23 --sessions FILE [--uploads 50]
//
//   --base-url URL          default http://127.0.0.1:58080 (the rehearsal's proxy)
//   --sessions FILE         from `npm run ops -- load-accounts` (step 73)
//   --compose FILE          sample each instance through `docker compose`
//                           (the local rehearsal); see "Sampling" below
//   --per-account-address   send X-Load-Client-IP (the rehearsal's nginx
//                           honours it; see nginx.conf.template)
//   --out FILE              the full results, as JSON
//
// Exit codes: 0 every gate passed, 1 a gate failed, 2 the run could not be
// made (bad arguments, too few accounts for the load asked for).
//
// WHAT A RUN DOES. Closed-model virtual users: each one pastes the longest
// document the product accepts (the same 3,919-word synthetic contract as
// checks.mjs long-analysis) and analyses it, then starts again, so the
// number of analyses in flight stays at --concurrency. Every account is one
// user at one address; accounts are used round-robin, so no account comes
// near NFR-2.6's 10 analyses an hour and the limits stay on.
//
// SAMPLING. Every 10 s (every 1 s for tr23), from EACH instance directly (not through the
// balancer, which would sample one at random): RSS, memory limit, and the
// database pool's in-use and waiting gauges, from its own /metrics; and
// Postgres's connection count. Only the docker-compose sampler exists: in
// staging the same numbers come from the metrics backend
// (docs/load-test-results.md says which queries), and none is chosen yet.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { longestPermittedDocument } from "../deploy/checks.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- pure

/** SRS numbers, in one place. */
export const LIMITS = Object.freeze({
  analysisP95Ms: 45_000, // NFR-1.1
  memoryFraction: 0.8, // NFR-1.3, and Appendix C's memory_high
  // TR-22 "flat memory": the least-squares trend of RSS over the run, after
  // warm-up, projected over two hours, must be under 5% of the limit
  // (about 26 MB at 512 MB). A leak of a few kilobytes per request over the
  // run's thousands of requests clears that easily; noise does not.
  soakGrowthFraction: 0.05,
  soakWarmupMs: 10 * 60_000,
});

/**
 * Nearest-rank percentile.
 * @param {number[]} values
 * @param {number} p 0 to 100
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/**
 * Least-squares slope of value over time, per hour.
 * @param {{ t: number, value: number }[]} points t in ms
 */
export function slopePerHour(points) {
  if (points.length < 2) return 0;
  const n = points.length;
  const mt = points.reduce((s, p) => s + p.t, 0) / n;
  const mv = points.reduce((s, p) => s + p.value, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - mt) * (p.value - mv);
    den += (p.t - mt) ** 2;
  }
  return den === 0 ? 0 : (num / den) * 3_600_000;
}

/**
 * The four gauges a sample needs, from one instance's /metrics text.
 * @param {string} text
 */
export function parseMetrics(text) {
  /** @param {string} name */
  const read = (name) => {
    const match = new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.eE+-]+)$`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  return {
    rss: read("process_resident_memory_bytes"),
    memoryLimit: read("memory_limit_bytes"),
    poolInUse: read("db_pool_in_use"),
    poolWaiting: read("db_pool_waiting"),
  };
}

/**
 * One address per account, in a private range: account i is one user at
 * one address, the way NFR-2.6's per-address limits expect real users.
 * @param {number} index
 */
export const clientAddressFor = (index) => `10.77.${Math.floor(index / 250)}.${(index % 250) + 1}`;

/**
 * The accounts a run needs so that none passes NFR-2.6's 10 analyses an
 * hour: every in-flight slot finishes one analysis per `latencyMs` at best.
 * @param {{ concurrency: number, minutes: number, latencyMs: number }} plan
 */
export function accountsNeeded({ concurrency, minutes, latencyMs }) {
  const perHourPerSlot = 3_600_000 / latencyMs;
  const analysesPerHour = concurrency * perHourPerSlot;
  // A run shorter than an hour still uses each account inside one hour's
  // window; a longer one spreads across windows.
  const perHourWindow = minutes >= 60 ? analysesPerHour : (analysesPerHour * minutes) / 60;
  return Math.ceil((perHourWindow / 10) * 1.2);
}

/**
 * @typedef {{ t: number, instance: string, rss: number | null, memoryLimit: number | null, poolInUse: number | null, poolWaiting: number | null }} InstanceSample
 * @typedef {{ t: number, connections: number | null }} DatabaseSample
 * @typedef {{ name: string, pass: boolean, detail: string }} Gate
 */

/**
 * @param {InstanceSample[]} samples
 * @param {number} fallbackLimit
 */
function memoryGate(samples, fallbackLimit) {
  const worst = samples.reduce(
    (w, s) => {
      const limit = s.memoryLimit ?? fallbackLimit;
      const fraction = s.rss === null ? 0 : s.rss / limit;
      return fraction > w.fraction ? { fraction, instance: s.instance, rss: s.rss ?? 0 } : w;
    },
    { fraction: 0, instance: "-", rss: 0 },
  );
  return {
    gate: {
      name: `no instance above ${LIMITS.memoryFraction * 100}% of its memory limit`,
      pass: samples.length > 0 && worst.fraction <= LIMITS.memoryFraction,
      detail:
        samples.length === 0
          ? "no samples: memory was not measured, so this cannot pass"
          : `worst ${(worst.fraction * 100).toFixed(1)}% (${(worst.rss / 1048576).toFixed(0)} MB, ${worst.instance})`,
    },
    worst,
  };
}

/** @param {InstanceSample[]} samples */
function poolGate(samples) {
  const waiting = Math.max(0, ...samples.map((s) => s.poolWaiting ?? 0));
  const inUse = Math.max(0, ...samples.map((s) => s.poolInUse ?? 0));
  return {
    name: "no database pool exhaustion (db_pool_waiting stays 0)",
    pass: samples.length > 0 && waiting === 0,
    detail: samples.length === 0 ? "no samples" : `peak in use ${inUse}, peak waiting ${waiting}`,
  };
}

/**
 * TR-21 (and NFR-1.3).
 * @param {{ analyses: { ms: number, status: number | null }[], samples: InstanceSample[], peakInFlight: number, concurrency: number, memoryLimit: number }} r
 * @returns {Gate[]}
 */
export function gatesTR21(r) {
  const ok = r.analyses.filter((a) => a.status === 200).map((a) => a.ms);
  const p95 = percentile(ok, 95);
  const serverErrors = r.analyses.filter((a) => a.status === null || a.status >= 500).length;
  return [
    {
      name: `${r.concurrency} analyses in flight at once`,
      pass: r.peakInFlight >= r.concurrency,
      detail: `peak ${r.peakInFlight}`,
    },
    {
      name: "p95 analysis time within NFR-1.1's 45 s",
      pass: p95 !== null && p95 <= LIMITS.analysisP95Ms,
      detail: p95 === null ? "no completed analysis" : `p95 ${(p95 / 1000).toFixed(1)} s over ${ok.length} analyses`,
    },
    {
      name: "zero 500s (or dropped connections)",
      pass: serverErrors === 0,
      detail: `${serverErrors} of ${r.analyses.length}`,
    },
    {
      name: "every analysis completed",
      pass: ok.length === r.analyses.length && ok.length > 0,
      detail: `${ok.length} of ${r.analyses.length} returned 200`,
    },
    memoryGate(r.samples, r.memoryLimit).gate,
    poolGate(r.samples),
  ];
}

/**
 * TR-22.
 * @param {{ analyses: { ms: number, status: number | null }[], samples: InstanceSample[], database: DatabaseSample[], startedAt: number, memoryLimit: number, minutes: number }} r
 * @returns {Gate[]}
 */
export function gatesTR22(r) {
  const after = r.samples.filter((s) => s.t - r.startedAt >= LIMITS.soakWarmupMs && s.rss !== null);
  const instances = [...new Set(after.map((s) => s.instance))];
  const growth = instances.map((instance) => {
    const points = after.filter((s) => s.instance === instance).map((s) => ({ t: s.t, value: /** @type {number} */ (s.rss) }));
    return { instance, perHour: slopePerHour(points), n: points.length };
  });
  const allowedPerHour = (LIMITS.soakGrowthFraction * r.memoryLimit) / 2;
  const connections = r.database.map((d) => d.connections).filter((c) => c !== null);
  const dbAfter = r.database.filter((d) => d.t - r.startedAt >= LIMITS.soakWarmupMs && d.connections !== null);
  const connectionTrend = slopePerHour(dbAfter.map((d) => ({ t: d.t, value: /** @type {number} */ (d.connections) })));
  const serverErrors = r.analyses.filter((a) => a.status === null || a.status >= 500).length;
  return [
    {
      name: `ran for ${r.minutes} minutes`,
      pass: r.samples.length > 0 && Math.max(...r.samples.map((s) => s.t)) - r.startedAt >= r.minutes * 60_000 * 0.98,
      detail: `${((Math.max(0, ...r.samples.map((s) => s.t)) - r.startedAt) / 60_000).toFixed(1)} minutes sampled`,
    },
    {
      name: "flat memory: RSS trend after warm-up, over two hours, under 5% of the limit",
      pass: growth.length > 0 && growth.every((g) => g.n >= 10 && g.perHour <= allowedPerHour),
      detail:
        growth.length === 0
          ? "no samples after warm-up"
          : growth.map((g) => `${g.instance} ${(g.perHour / 1048576).toFixed(2)} MB/h over ${g.n} samples`).join("; ") +
            ` (allowed ${(allowedPerHour / 1048576).toFixed(1)} MB/h)`,
    },
    {
      name: "stable connection count",
      pass: connections.length > 0 && Math.abs(connectionTrend) < 1,
      detail:
        connections.length === 0
          ? "no samples"
          : `Postgres connections ${Math.min(...connections)} to ${Math.max(...connections)}, trend ${connectionTrend.toFixed(2)}/h after warm-up`,
    },
    {
      name: "zero 500s (or dropped connections)",
      pass: serverErrors === 0,
      detail: `${serverErrors} of ${r.analyses.length}`,
    },
    memoryGate(r.samples, r.memoryLimit).gate,
    poolGate(r.samples),
  ];
}

/**
 * TR-23.
 * @param {{ uploads: { status: number | null, code: string | null }[], samples: InstanceSample[], containers: { name: string, oomKilled: boolean, restarts: number, running?: boolean, cgroup?: Record<string, number> }[], readyAfter: boolean, memoryLimit: number }} r
 * @returns {Gate[]}
 */
export function gatesTR23(r) {
  const busy = r.uploads.filter((u) => u.status === 503 && u.code === "SERVER_BUSY").length;
  const serverErrors = r.uploads.filter((u) => u.status === null || (u.status >= 500 && u.code !== "SERVER_BUSY")).length;
  const died = r.containers.filter((c) => c.oomKilled || c.restarts > 0 || c.running === false);
  // "Did not OOM" means nothing where the kernel could swap instead: a
  // container with swap survives a demand far past its limit.
  const swapCapable = r.containers.filter((c) => (c.cgroup?.["memory.swap.max"] ?? 0) > 0);
  return [
    {
      name: "a valid test: no instance had swap to hide in",
      pass: r.containers.length > 0 && r.containers.every((c) => c.cgroup?.["memory.swap.max"] === 0),
      detail:
        r.containers.length === 0
          ? "containers not inspected"
          : swapCapable.length > 0
            ? `swap available to ${swapCapable.map((c) => c.name).join(", ")}: surviving proves nothing`
            : r.containers.every((c) => c.cgroup?.["memory.swap.max"] === 0)
              ? "memory.swap.max 0 on every instance"
              : "cgroup not read (an instance that is no longer running cannot be asked)",
    },
    {
      name: "the concurrency cap answers 503 SERVER_BUSY",
      pass: busy > 0,
      detail: `${busy} of ${r.uploads.length} refused with SERVER_BUSY`,
    },
    {
      name: "no other 5xx and no dropped connection",
      pass: serverErrors === 0,
      detail: `${serverErrors} of ${r.uploads.length}`,
    },
    {
      name: "no instance OOM-killed or restarted",
      pass: r.containers.length > 0 && died.length === 0,
      detail:
        r.containers.length === 0
          ? "containers not inspected"
          : died.length === 0
            ? `${r.containers.length} instance(s), none killed or restarted`
            : died.map((c) => `${c.name}: oomKilled=${c.oomKilled} restarts=${c.restarts} running=${c.running}`).join("; "),
    },
    { name: "still ready afterwards", pass: r.readyAfter, detail: r.readyAfter ? "/api/ready 200" : "/api/ready not 200" },
  ];
}

// ------------------------------------------------------------- runtime

/**
 * Samples every instance of a docker-compose stack directly.
 * @param {string} composeFile
 * @param {string} metricsToken
 */
export function dockerSampler(composeFile, metricsToken) {
  const compose = ["compose", "-f", composeFile];
  return {
    /** @returns {Promise<string[]>} */
    async instances() {
      const { stdout } = await run("docker", [...compose, "ps", "--services", "--status", "running"]);
      return stdout.split("\n").filter((s) => /^api\d+$/.test(s.trim())).map((s) => s.trim());
    },
    /** @param {string} instance */
    async metrics(instance) {
      const { stdout } = await run("docker", [
        ...compose,
        "exec",
        "-T",
        instance,
        "wget",
        "-qO-",
        "--header",
        `Authorization: Bearer ${metricsToken}`,
        "http://127.0.0.1:3000/metrics",
      ]);
      return parseMetrics(stdout);
    },
    async databaseConnections() {
      const { stdout } = await run("docker", [
        ...compose,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "rehearsal",
        "-d",
        "rehearsal",
        "-tAc",
        "select count(*) from pg_stat_activity where datname = 'rehearsal'",
      ]);
      return Number(stdout.trim());
    },
    /**
     * What happened to each instance's memory, from its cgroup, which is
     * what the kernel enforces: its limit, its high-water mark, whether it
     * had swap to hide in, how often it hit the limit and whether anything
     * in it was OOM-killed. Plus Docker's view: killed, or restarted.
     * @param {string[]} instances
     */
    async containers(instances) {
      const out = [];
      for (const instance of instances) {
        const { stdout: id } = await run("docker", [...compose, "ps", "-aq", instance]);
        const { stdout: state } = await run("docker", [
          "inspect",
          "-f",
          "{{.State.OOMKilled}} {{.RestartCount}} {{.State.Running}}",
          id.trim(),
        ]);
        const [oom, restarts, running] = state.trim().split(" ");
        /** @type {Record<string, number>} */
        const cgroup = {};
        if (running === "true") {
          const { stdout } = await run("docker", [
            ...compose,
            "exec",
            "-T",
            instance,
            "sh",
            "-c",
            "cd /sys/fs/cgroup && for f in memory.max memory.peak memory.swap.max memory.swap.peak; do echo \"$f $(cat $f)\"; done; " +
              "grep -E '^(max|oom|oom_kill) ' memory.events | sed 's/^/events./'",
          ]).catch(() => ({ stdout: "" }));
          for (const line of stdout.split("\n")) {
            const [key, value] = line.trim().split(" ");
            if (key && value !== undefined) cgroup[key] = value === "max" ? Infinity : Number(value);
          }
        }
        out.push({
          name: instance,
          oomKilled: oom === "true" || (cgroup["events.oom_kill"] ?? 0) > 0,
          restarts: Number(restarts),
          running: running === "true",
          cgroup,
        });
      }
      return out;
    },
  };
}

/**
 * @param {ReturnType<typeof dockerSampler> | null} sampler
 * @param {() => boolean} running
 * @param {InstanceSample[]} samples
 * @param {DatabaseSample[]} database
 * @param {number} everyMs
 */
async function sampleLoop(sampler, running, samples, database, everyMs) {
  if (!sampler) return;
  const instances = await sampler.instances();
  while (running()) {
    const t = Date.now();
    await Promise.all(
      instances.map(async (instance) => {
        const m = await sampler.metrics(instance).catch(() => null);
        if (m) samples.push({ t, instance, ...m });
      }),
    );
    database.push({ t, connections: await sampler.databaseConnections().catch(() => null) });
    const wait = everyMs - (Date.now() - t);
    const end = Date.now() + Math.max(0, wait);
    while (running() && Date.now() < end) await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now())));
  }
}

/**
 * @param {{ baseUrl: string, cookie: string, address?: string }} who
 * @param {string} path
 * @param {RequestInit} init
 */
function call(who, path, init) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", who.cookie);
  if (who.address) headers.set("X-Load-Client-IP", who.address);
  return fetch(`${who.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(200_000) });
}

/**
 * The closed-model analysis load, shared by TR-21 and TR-22.
 * @param {{ baseUrl: string, accounts: { cookie: string }[], concurrency: number, minutes: number, perAccountAddress: boolean, document: string, log: (line: string) => void }} o
 */
async function analysisLoad(o) {
  const until = Date.now() + o.minutes * 60_000;
  /** @type {{ ms: number, status: number | null, code: string | null, at: number }[]} */
  const analyses = [];
  let next = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let lastReport = Date.now();

  async function user() {
    while (Date.now() < until) {
      const index = next % o.accounts.length;
      next += 1;
      const who = {
        baseUrl: o.baseUrl,
        cookie: o.accounts[index].cookie,
        address: o.perAccountAddress ? clientAddressFor(index) : undefined,
      };
      let status = null;
      let code = null;
      const started = Date.now();
      try {
        const created = await call(who, "/api/v1/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: o.document }),
        });
        const body = /** @type {any} */ (await created.json().catch(() => null));
        if (created.status !== 201) {
          status = created.status;
          code = body?.error?.code ?? null;
        } else {
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          const t0 = Date.now();
          try {
            const res = await call(who, `/api/v1/documents/${body.document.id}/analyze`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
            status = res.status;
            code = res.status === 200 ? null : ((/** @type {any} */ (await res.json().catch(() => null)))?.error?.code ?? null);
            if (res.status === 200) await res.arrayBuffer().catch(() => undefined);
            analyses.push({ ms: Date.now() - t0, status, code, at: t0 });
          } finally {
            inFlight -= 1;
          }
          continue;
        }
      } catch {
        // A dropped connection: status stays null, counted below as one.
      }
      // The upload itself failed: counted as a failed analysis, so it can
      // never quietly shrink the sample the p95 is taken over.
      analyses.push({ ms: Date.now() - started, status, code, at: started });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const reporter = setInterval(() => {
    if (Date.now() - lastReport < 60_000) return;
    lastReport = Date.now();
    const done = analyses.filter((a) => a.status === 200).length;
    o.log(`  ${new Date().toISOString().slice(11, 19)}  in flight ${inFlight}, completed ${done}, failed ${analyses.length - done}`);
  }, 5_000);
  await Promise.all(Array.from({ length: o.concurrency }, () => user()));
  clearInterval(reporter);
  return { analyses, peakInFlight };
}

/** A just-under-5 MB PDF: ten pages of text, and 4.8 MB of incompressible stream. */
async function fiveMegabytePdf() {
  const { default: PDFDocument } = await import(join(HERE, "..", "..", "server", "node_modules", "pdfkit", "js", "pdfkit.js"));
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ compress: false });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    for (let page = 0; page < 10; page += 1) {
      if (page > 0) doc.addPage();
      doc.text(`SERVICES AGREEMENT, page ${page + 1}. `.repeat(40));
    }
    const filler = doc.ref({ Type: "EmbeddedFile" });
    filler.write(randomBytes(4_800_000));
    filler.end();
    doc.end();
  });
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const [scenario, ...rest] = argv;
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i].replace(/^--/, "");
    if (flag === "per-account-address") flags[flag] = true;
    else flags[flag] = rest[(i += 1)];
  }
  return { scenario, flags };
}

async function main() {
  const { scenario, flags } = parseArgs(process.argv.slice(2));
  const log = (/** @type {string} */ line) => console.log(line);
  if (!["tr21", "tr22", "tr23"].includes(scenario) || typeof flags.sessions !== "string") {
    console.error("usage: node ops/load/load.mjs tr21|tr22|tr23 --sessions FILE [--compose FILE] [--per-account-address] [--out FILE]");
    return 2;
  }
  const baseUrl = String(flags["base-url"] ?? "http://127.0.0.1:58080").replace(/\/$/, "");
  const { accounts } = JSON.parse(await readFile(String(flags.sessions), "utf8"));
  const perAccountAddress = flags["per-account-address"] === true;
  const memoryLimit = Number(flags["memory-limit"] ?? 536_870_912);
  const sampler =
    typeof flags.compose === "string"
      ? dockerSampler(flags.compose, String(flags["metrics-token"] ?? process.env.METRICS_TOKEN ?? ""))
      : null;
  if (!sampler) log("WARNING: no sampler (--compose): memory and pool gates cannot pass without measurements");

  /** @type {InstanceSample[]} */
  const samples = [];
  /** @type {DatabaseSample[]} */
  const database = [];
  let active = true;
  const startedAt = Date.now();
  // Every second for the upload flood, whose spike lasts seconds and would
  // fall between 10-second samples; every 10 s for the long runs.
  const sampling = sampleLoop(sampler, () => active, samples, database, scenario === "tr23" ? 1_000 : 10_000);

  /** @type {Gate[]} */
  let gates;
  /** @type {Record<string, unknown>} */
  let result;
  try {
    if (scenario === "tr23") {
      const count = Number(flags.uploads ?? 50);
      if (accounts.length < count) {
        console.error(`tr23 needs ${count} accounts (one per upload, so no account's storage quota decides the outcome); got ${accounts.length}`);
        return 2;
      }
      // The instances and their cgroup settings, read BEFORE the flood: an
      // instance the flood kills cannot be asked afterwards, and a run
      // that only inspected survivors would report "none killed" when all
      // of them were.
      const before = sampler ? await sampler.containers(await sampler.instances()) : [];
      const pdf = await fiveMegabytePdf();
      log(`${count} simultaneous uploads of ${(pdf.length / 1e6).toFixed(2)} MB`);
      await new Promise((r) => setTimeout(r, 2_000)); // a baseline sample first
      const uploads = await Promise.all(
        accounts.slice(0, count).map(async (/** @type {{ cookie: string }} */ a, /** @type {number} */ i) => {
          const form = new FormData();
          form.append("file", new Blob([pdf], { type: "application/pdf" }), `flood-${i}.pdf`);
          try {
            const res = await call({ baseUrl, cookie: a.cookie, address: perAccountAddress ? clientAddressFor(i) : undefined }, "/api/v1/documents", {
              method: "POST",
              body: form,
            });
            const body = /** @type {any} */ (await res.json().catch(() => null));
            return { status: res.status, code: body?.error?.code ?? null };
          } catch {
            return { status: null, code: null };
          }
        }),
      );
      await new Promise((r) => setTimeout(r, 12_000)); // let the samplers see the aftermath
      const after = sampler ? await sampler.containers(before.map((c) => c.name)) : [];
      const containers = after.map((c) => {
        const earlier = before.find((b) => b.name === c.name);
        return { ...c, cgroup: { ...earlier?.cgroup, ...c.cgroup } };
      });
      const readyAfter = (await fetch(`${baseUrl}/api/ready`).catch(() => null))?.status === 200;
      const byOutcome = uploads.reduce((m, u) => {
        const key = `${u.status ?? "dropped"} ${u.code ?? ""}`.trim();
        m[key] = (m[key] ?? 0) + 1;
        return m;
      }, /** @type {Record<string, number>} */ ({}));
      log(`  outcomes: ${JSON.stringify(byOutcome)}`);
      for (const c of containers) {
        const g = c.cgroup ?? {};
        log(
          `  ${c.name}: cgroup peak ${((g["memory.peak"] ?? 0) / 1048576).toFixed(0)} MB of ${((g["memory.max"] ?? 0) / 1048576).toFixed(0)} MB, ` +
            `hit the limit ${g["events.max"] ?? "?"} time(s), swap max ${g["memory.swap.max"] ?? "?"}, oom_kill ${g["events.oom_kill"] ?? "?"}`,
        );
      }
      result = { uploads, byOutcome, containers, readyAfter, bytes: pdf.length };
      gates = gatesTR23({ uploads, samples, containers, readyAfter, memoryLimit });
    } else {
      const tr21 = scenario === "tr21";
      const minutes = Number(flags.minutes ?? (tr21 ? 10 : 120));
      const concurrency = Number(flags.concurrency ?? (tr21 ? 20 : 5));
      const latencyMs = Number(flags["expected-latency-ms"] ?? 25_000);
      const needed = accountsNeeded({ concurrency, minutes, latencyMs });
      if (accounts.length < needed) {
        console.error(
          `${accounts.length} accounts is too few for ${concurrency} in flight for ${minutes} min at ~${latencyMs / 1000} s each: ` +
            `NFR-2.6 allows 10 analyses per account per hour, so this needs at least ${needed}`,
        );
        return 2;
      }
      const source = await readFile(join(HERE, "..", "..", "server", "tests", "fixtures", "05-oversized-msa.txt"), "utf8");
      const { text, words } = longestPermittedDocument(source);
      log(`${scenario}: ${concurrency} in flight for ${minutes} min, ${accounts.length} accounts, a ${words}-word document`);
      const { analyses, peakInFlight } = await analysisLoad({ baseUrl, accounts, concurrency, minutes, perAccountAddress, document: text, log });
      const ok = analyses.filter((a) => a.status === 200).map((a) => a.ms);
      const failures = analyses.reduce((m, a) => {
        if (a.status === 200) return m;
        const key = `${a.status ?? "dropped"} ${a.code ?? ""}`.trim();
        m[key] = (m[key] ?? 0) + 1;
        return m;
      }, /** @type {Record<string, number>} */ ({}));
      const latency = { n: ok.length, p50: percentile(ok, 50), p95: percentile(ok, 95), p99: percentile(ok, 99), max: percentile(ok, 100) };
      log(`  latency (ms): ${JSON.stringify(latency)}`);
      if (Object.keys(failures).length > 0) log(`  failures: ${JSON.stringify(failures)}`);
      result = { latency, failures, peakInFlight, analyses: analyses.length, concurrency, minutes };
      gates = tr21
        ? gatesTR21({ analyses, samples, peakInFlight, concurrency, memoryLimit })
        : gatesTR22({ analyses, samples, database, startedAt, memoryLimit, minutes });
    }
  } finally {
    active = false;
    await sampling;
  }

  const peak = /** @type {Record<string, number>} */ ({});
  for (const s of samples) peak[s.instance] = Math.max(peak[s.instance] ?? 0, s.rss ?? 0);
  log(`  peak RSS: ${Object.entries(peak).map(([k, v]) => `${k} ${(v / 1048576).toFixed(0)} MB`).join(", ") || "not sampled"}`);
  const connections = database.map((d) => d.connections).filter((c) => c !== null);
  if (connections.length > 0) log(`  Postgres connections: ${Math.min(...connections)} to ${Math.max(...connections)}`);
  log("");
  for (const g of gates) log(`  [${g.pass ? "PASS" : "FAIL"}] ${g.name}: ${g.detail}`);

  if (typeof flags.out === "string") {
    await writeFile(
      flags.out,
      JSON.stringify({ scenario, baseUrl, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), result, gates, samples, database }, null, 1),
      "utf8",
    );
  }
  return gates.every((g) => g.pass) ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
