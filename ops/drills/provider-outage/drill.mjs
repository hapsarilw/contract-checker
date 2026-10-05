// BUILD-PLAN step 75 / PRD §9, Phase 1.5 definition of done, item 3:
// "A simulated provider outage — mocked 529 for five minutes — produces a
// stated degraded-mode error, no data loss, no pending analyses stuck, and
// ONE alert, not a pager storm."
//
// Run by run.sh, against the deploy rehearsal plus Prometheus, Alertmanager
// and a webhook recorder (compose.yml here). Dependency-free, like
// ops/load/load.mjs, whose helpers it shares.
//
//   node ops/drills/provider-outage/drill.mjs --sessions FILE --notifications DIR
//        --compose-file F [--compose-file F2 ...]
//        [--baseline-minutes 7] [--outage-minutes 5] [--after-minutes 5]
//        [--after-max-minutes 35] [--think-ms 2000] [--out FILE]
//
// THE BASELINE IS SEVEN MINUTES because the slowest rule groups evaluate
// every five: a shorter one let risk_drift_high, which the mock's own
// reports had been setting off from the start, first evaluate DURING the
// first run's outage and look like part of it. The baseline gate now
// requires every rule group to have evaluated on baseline traffic.
//
// THE TIMELINE. Traffic runs for the whole drill: one user uploading a fresh
// document, analysing it, pausing --think-ms, and again; one reader listing
// documents and opening reports that finished before the outage. After
// --baseline-minutes the outage file is written into both API containers
// (from then on every provider call answers 529, as the real provider does
// when it is overloaded), and it is removed --outage-minutes later. The run
// then watches for at least --after-minutes, and on until nothing is firing
// or pending anywhere and every alert that notified has notified its
// resolution, or --after-max-minutes.
//
// --think-ms decides which outage is being drilled. At 2 s an analysis
// starts every few seconds and the breaker trips (FR-3.12 needs 20 calls in
// 5 minutes, half of them failing); at 60 s it never does, which is what an
// outage looks like on a quiet day. One alert has to hold for both.
//
// WHAT IS MEASURED, AND FROM WHERE
//   responses       the traffic's own record of every request it made
//   alerts          Prometheus's /api/v1/alerts and Alertmanager's
//                   /api/v2/alerts, polled every 10 s: what was pending, what
//                   fired, what Alertmanager inhibited
//   notifications   what Alertmanager actually SENT, as the recorder wrote it.
//                   This, not the polling, is what the one-alert gate counts
//   the database    PENDING rows, reaped rows, error codes, and a digest of
//                   every row that existed before the outage, compared after
//   the breaker     llm_circuit_state from Prometheus, and its own log lines
//
// Exit codes: 0 every gate passed, 1 a gate failed, 2 the run could not be made.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { ERROR_CODES } from "../../../server/src/lib/errorCodes.js";
import { clientAddressFor } from "../../load/load.mjs";

const run = promisify(execFile);

// ---------------------------------------------------------------- pure

/** The numbers the gates use, in one place. */
export const DRILL = Object.freeze({
  // What the user is told (SRS §4.3's example, errorCodes.js verbatim).
  degradedMessage: ERROR_CODES.LLM_UNAVAILABLE.message,
  retryAfter: String(ERROR_CODES.LLM_UNAVAILABLE.retryAfter),
  // FR-3.12 opens the breaker for 60 s and then lets one trial through.
  // Recovery is due within that, plus the trial, plus a scrape or two.
  recoveryMs: 150_000,
  // Below these, a gate would be passing on too little to mean anything.
  minDegradedResponses: 3,
  minReadsDuringOutage: 30,
  reanalyses: 5,
});

/**
 * @typedef {{ at: number, ms: number, status: number | null, code: string | null, retryAfter: string | null, message: string | null, documentId: string | null }} AnalysisCall
 * @typedef {{ at: number, kind: "list" | "report", status: number | null, ok: boolean, why?: string }} Read
 * @typedef {{ t: number, alerts: { alertname: string, state: string }[] }} PromSample
 * @typedef {{ t: number, alerts: { alertname: string, route: string, domain: string, state: string, inhibitedBy: string[] }[] }} AmSample
 * @typedef {{ at: number, receiver: string, groupKey: string, status: string, firing: string[], resolved: string[], groupLabels: Record<string, string> }} Notification
 * @typedef {{ name: string, pass: boolean, detail: string }} Gate
 */

/**
 * One notification from the recorder's line, in the shape the gates use.
 * @param {{ at: string, body: any }} line
 * @returns {Notification}
 */
export function parseNotification(line) {
  const body = line.body ?? {};
  /** @type {{ status?: string, labels?: Record<string, string> }[]} */
  const alerts = Array.isArray(body.alerts) ? body.alerts : [];
  const names = (/** @type {string} */ status) =>
    alerts.filter((a) => a.status === status).map((a) => a.labels?.alertname ?? "?");
  return {
    at: Date.parse(line.at),
    receiver: String(body.receiver ?? "?"),
    groupKey: String(body.groupKey ?? "?"),
    status: String(body.status ?? "?"),
    firing: names("firing"),
    resolved: names("resolved"),
    groupLabels: body.groupLabels ?? {},
  };
}

/**
 * The alert groups that notified as FIRING at or after `from`: one entry
 * per group key, which is what a paging provider deduplicates an incident
 * on. Every notification of that group (firing and resolved) is counted
 * against it, so "one alert" and "how many messages it took" are both
 * visible.
 * @param {Notification[]} notifications
 * @param {number} from
 */
export function notifiedGroups(notifications, from) {
  /** @type {Map<string, { groupKey: string, receiver: string, groupLabels: Record<string, string>, firstAt: number, alertnames: Set<string>, firing: number, resolved: number }>} */
  const groups = new Map();
  for (const n of [...notifications].sort((a, b) => a.at - b.at)) {
    if (n.at < from) continue;
    let g = groups.get(n.groupKey);
    if (!g) {
      if (n.status !== "firing") continue;
      g = { groupKey: n.groupKey, receiver: n.receiver, groupLabels: n.groupLabels, firstAt: n.at, alertnames: new Set(), firing: 0, resolved: 0 };
      groups.set(n.groupKey, g);
    }
    for (const name of n.firing) g.alertnames.add(name);
    if (n.status === "firing") g.firing += 1;
    else g.resolved += 1;
  }
  return [...groups.values()].map((g) => ({ ...g, alertnames: [...g.alertnames].sort() }));
}

/**
 * Groups Alertmanager held an UNSUPPRESSED alert in, at the last poll: each
 * of them will notify once its group_wait is up, whether or not the run is
 * still watching by then. Keyed as alertmanager.yml groups (route, domain).
 * @param {AmSample[]} samples
 */
export function pendingGroupsAtEnd(samples) {
  const last = samples.at(-1);
  if (!last) return [];
  return [...new Set(last.alerts.filter((a) => a.state === "active").map((a) => `${a.route}/${a.domain}`))].sort();
}

/**
 * Every 0/1 change of a gauge sampled over time, for the breaker's state.
 * @param {[number, number][]} points [t, value]
 */
export function transitions(points) {
  /** @type {{ t: number, to: number }[]} */
  const out = [];
  for (let i = 1; i < points.length; i += 1) {
    if (points[i][1] !== points[i - 1][1]) out.push({ t: points[i][0], to: points[i][1] });
  }
  return out;
}

/** @param {number} ms */
const minutes = (ms) => `${(ms / 60_000).toFixed(1)} min`;

/**
 * Every pause longer than `limitMs` between consecutive ticks of a loop that
 * should tick steadily: the reader (every second) and the alert poller
 * (every 10 s). Both pausing together means the HOST stopped, not the API:
 * the first run's laptop went into idle sleep 2.4 minutes into the outage,
 * and everything measured with a clock after that was measured across gaps
 * of up to 15 minutes.
 * @param {number[]} ticks
 * @param {number} limitMs
 */
export function stalls(ticks, limitMs) {
  const sorted = [...ticks].sort((a, b) => a - b);
  /** @type {{ from: number, ms: number }[]} */
  const out = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > limitMs) out.push({ from: sorted[i - 1], ms: gap });
  }
  return out;
}

/**
 * The verdicts. Every gate needs evidence to pass: a run that measured
 * nothing fails, it does not pass vacuously.
 *
 * @param {{
 *   startedAt: number, outageStartAt: number, outageEndAt: number,
 *   baselineRules: { name: string, lastEvaluationAt: number }[],
 *   analyses: AnalysisCall[], reads: Read[], reanalyses: { status: number | null }[],
 *   prom: PromSample[], am: AmSample[], notifications: Notification[],
 *   database: { snapshotBefore: string | null, snapshotAfter: string | null, pendingAtEnd: number | null, reaped: number | null, failedCodes: Record<string, number>, outageDocuments: { uploaded: number, present: number | null } },
 *   observedUntilQuiet: boolean,
 * }} r
 * @returns {Gate[]}
 */
export function gatesOutage(r) {
  const before = (/** @type {number} */ t) => t < r.outageStartAt;
  const promBefore = r.prom.filter((s) => before(s.t));
  const amBefore = r.am.filter((s) => before(s.t));
  const alertsBefore = [...new Set([...promBefore, ...amBefore].flatMap((s) => s.alerts.map((a) => a.alertname)))];
  const notifiedBefore = r.notifications.filter((n) => before(n.at));
  // A rule group that has not evaluated since traffic had a minute to
  // produce samples has not been observed, quiet or not.
  const unevaluated = r.baselineRules.filter((g) => !(g.lastEvaluationAt >= r.startedAt + 60_000));

  const during = r.analyses.filter((a) => a.at >= r.outageStartAt && a.at < r.outageEndAt);
  const failedDuring = during.filter((a) => a.status !== 200);
  const stated = failedDuring.filter(
    (a) =>
      a.status === 503 &&
      a.code === "LLM_UNAVAILABLE" &&
      a.retryAfter === DRILL.retryAfter &&
      a.message === DRILL.degradedMessage,
  );

  const recovered = r.analyses.find((a) => a.at >= r.outageEndAt && a.status === 200);
  const recoveredAt = recovered ? recovered.at + recovered.ms : null;
  const unexpected = r.analyses.filter(
    (a) =>
      a.status !== 200 &&
      !(a.code === "LLM_UNAVAILABLE" && a.at >= r.outageStartAt && a.at <= (recoveredAt ?? Infinity)),
  );

  const readsDuring = r.reads.filter((x) => x.at >= r.outageStartAt && x.at < r.outageEndAt);
  const badReads = r.reads.filter((x) => !x.ok);

  const groups = notifiedGroups(r.notifications, r.outageStartAt);
  const notYetSent = pendingGroupsAtEnd(r.am).filter(
    (key) => !groups.some((g) => `${g.groupLabels.route}/${g.groupLabels.domain}` === key),
  );
  const describe = (/** @type {ReturnType<typeof notifiedGroups>[number]} */ g) =>
    `${g.receiver} ${JSON.stringify(g.groupLabels)}: [${g.alertnames.join(", ")}], first ${minutes(g.firstAt - r.outageStartAt)} after the outage began, ${g.firing} firing + ${g.resolved} resolved message(s)`;
  const db = r.database;
  const otherFailures = Object.entries(db.failedCodes).filter(([code]) => code !== "LLM_UNAVAILABLE");
  // The reader waits for each answer, so one slow read is a gap too; the
  // limit allows for that and for a poll that times out (10 s).
  const hostStalls = [
    ...stalls(r.reads.map((x) => x.at), 30_000),
    ...stalls(r.prom.map((x) => x.t), 30_000),
  ];

  return [
    {
      name: "a valid run: the host never stalled (every loop kept its pace)",
      pass: r.reads.length > 0 && r.prom.length > 0 && hostStalls.length === 0,
      detail:
        hostStalls.length === 0
          ? `${r.reads.length} reads and ${r.prom.length} polls, no gap over 30 s`
          : `INVALID RUN: ${hostStalls.length} gap(s), the longest ${(Math.max(...hostStalls.map((x) => x.ms)) / 1000).toFixed(0)} s, the first ${minutes(hostStalls[0].from - r.outageStartAt)} after the outage began. Timings across a gap are not measurements`,
    },
    {
      name: "a clean baseline: every rule group evaluated on it, nothing pending, firing or notified",
      pass:
        promBefore.length > 0 &&
        amBefore.length > 0 &&
        r.baselineRules.length > 0 &&
        unevaluated.length === 0 &&
        alertsBefore.length === 0 &&
        notifiedBefore.length === 0,
      detail:
        promBefore.length === 0 || amBefore.length === 0 || r.baselineRules.length === 0
          ? "no alert polls or rule groups before the outage: the baseline was not observed"
          : unevaluated.length
            ? `not evaluated on baseline traffic: ${unevaluated.map((g) => g.name).join(", ")}`
            : alertsBefore.length || notifiedBefore.length
              ? `before the outage: ${alertsBefore.join(", ") || "-"}; ${notifiedBefore.length} notification(s). Anything counted after would not be the outage's`
              : `${r.baselineRules.length} rule groups evaluated, ${promBefore.length} polls, nothing pending or firing, nothing sent`,
    },
    {
      name: "the degraded-mode error is stated: 503 LLM_UNAVAILABLE, Retry-After 60, the document-is-saved message",
      pass: failedDuring.length >= DRILL.minDegradedResponses && stated.length === failedDuring.length,
      detail: `${stated.length} of ${failedDuring.length} failed analyses during the outage (${during.length - failedDuring.length} in-flight one(s) completed)`,
    },
    {
      name: "nothing else failed: no 500, no dropped connection, no other code, before, during or after",
      pass: r.analyses.length > 0 && unexpected.length === 0,
      detail:
        unexpected.length === 0
          ? `${r.analyses.length} analyses, every non-200 a 503 LLM_UNAVAILABLE inside the outage and its recovery`
          : unexpected
              .slice(0, 5)
              .map((a) => `${a.status ?? "dropped"} ${a.code ?? ""} at ${minutes(a.at - r.outageStartAt)}`)
              .join("; "),
    },
    {
      name: "reads are unaffected: every list and report read answered, with the pre-outage report intact",
      pass: readsDuring.length >= DRILL.minReadsDuringOutage && badReads.length === 0,
      detail:
        badReads.length === 0
          ? `${r.reads.length} reads, ${readsDuring.length} during the outage, all 200 and intact`
          : badReads.slice(0, 5).map((x) => `${x.kind} ${x.status ?? "dropped"} ${x.why ?? ""}`).join("; "),
    },
    {
      name: "no data loss: every row that existed before the outage is unchanged after it",
      pass: db.snapshotBefore !== null && db.snapshotBefore === db.snapshotAfter,
      detail:
        db.snapshotBefore === null || db.snapshotAfter === null
          ? "the database digest was not taken"
          : db.snapshotBefore === db.snapshotAfter
            ? `digest ${db.snapshotBefore.slice(0, 12)} before and after`
            : `digest ${db.snapshotBefore.slice(0, 12)} before, ${db.snapshotAfter.slice(0, 12)} after`,
    },
    {
      name: "every document uploaded during the outage was kept, and analyses once it is over",
      pass:
        db.outageDocuments.uploaded > 0 &&
        db.outageDocuments.present === db.outageDocuments.uploaded &&
        r.reanalyses.length > 0 &&
        r.reanalyses.every((x) => x.status === 200),
      detail: `${db.outageDocuments.present ?? "?"} of ${db.outageDocuments.uploaded} kept; ${r.reanalyses.filter((x) => x.status === 200).length} of ${r.reanalyses.length} re-analysed after recovery`,
    },
    {
      name: "no analysis stuck: none PENDING at the end, none left for the reaper, every failure LLM_UNAVAILABLE",
      pass: db.pendingAtEnd === 0 && db.reaped === 0 && otherFailures.length === 0 && (db.failedCodes.LLM_UNAVAILABLE ?? 0) > 0,
      detail: `PENDING ${db.pendingAtEnd ?? "?"}, reaped ${db.reaped ?? "?"}, failed by code ${JSON.stringify(db.failedCodes)}`,
    },
    {
      name: `analysis recovers within ${DRILL.recoveryMs / 1000} s of the provider recovering`,
      pass: recoveredAt !== null && recoveredAt - r.outageEndAt <= DRILL.recoveryMs,
      detail: recoveredAt === null ? "no analysis succeeded after the outage" : `first success ${((recoveredAt - r.outageEndAt) / 1000).toFixed(0)} s after`,
    },
    {
      name: "ONE alert: exactly one alert group notified, and no other one waiting to",
      pass: groups.length === 1 && notYetSent.length === 0 && r.observedUntilQuiet,
      detail:
        (groups.length === 0 ? "no alert group notified" : groups.map(describe).join(" | ")) +
        (notYetSent.length ? `; still active and not yet sent: ${notYetSent.join(", ")}` : "") +
        (r.observedUntilQuiet ? "" : "; the run ended before everything had resolved"),
    },
    {
      name: "the one alert points at the cause: the provider, on the pager",
      pass: groups.length === 1 && groups[0].receiver === "page" && groups[0].groupLabels.domain === "provider",
      detail: groups.length === 1 ? describe(groups[0]) : `${groups.length} groups`,
    },
  ];
}

/**
 * A synthetic contract of a little over 200 words (MIN_DOCUMENT_WORDS),
 * different every time so no two uploads are the same document. Synthetic
 * by construction, as SRS §2.3 requires of anything outside development.
 * @param {string} runId
 * @param {number} n
 */
export function drillContract(runId, n) {
  return [
    `SERVICES AGREEMENT ${runId}-${n}`,
    `This Services Agreement is made between Example Client Ltd ("Client") and the Contractor named in Schedule ${n} ("Contractor"). The Contractor will provide design services as described in each statement of work agreed in writing by both parties.`,
    "1. Payment. The Client will pay each invoice within ninety (90) days of receipt. Late payments will not accrue interest. The Client may withhold payment for any deliverable it considers unsatisfactory, at its sole discretion.",
    "2. Intellectual property. All work product, including preliminary drafts, sketches and concepts not delivered to the Client, is assigned to the Client upon creation, whether or not the Client has paid for it.",
    "3. Termination. The Client may terminate this Agreement at any time without notice. On termination the Contractor is entitled only to payment for deliverables already accepted in writing.",
    "4. Liability. The Contractor's liability under this Agreement is unlimited. The Contractor will indemnify the Client against any claim arising from the services, however caused.",
    "5. Non-compete. For twenty-four (24) months after termination the Contractor will not provide similar services to any business in the same industry as the Client, anywhere in the world.",
    "6. Governing law. This Agreement is governed by the laws of the jurisdiction the Client chooses at the time of any dispute.",
    "7. Confidentiality. The Contractor will keep confidential all information received from the Client, without limit of time, including information that is already public.",
  ].join("\n\n");
}

// ------------------------------------------------------------- runtime

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/**
 * @param {{ baseUrl: string, cookie: string, address: string }} who
 * @param {string} path
 * @param {RequestInit} [init]
 */
function call(who, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", who.cookie);
  headers.set("X-Load-Client-IP", who.address);
  return fetch(`${who.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(200_000) });
}

/** @param {Response} res */
async function errorOf(res) {
  const body = /** @type {any} */ (await res.json().catch(() => null));
  return { code: body?.error?.code ?? null, message: body?.error?.message ?? null };
}

async function main() {
  const { values: flags } = parseArgs({
    options: {
      "base-url": { type: "string", default: "http://127.0.0.1:58080" },
      prometheus: { type: "string", default: "http://127.0.0.1:59090" },
      alertmanager: { type: "string", default: "http://127.0.0.1:59093" },
      sessions: { type: "string" },
      notifications: { type: "string" },
      "compose-file": { type: "string", multiple: true },
      "baseline-minutes": { type: "string", default: "7" },
      "outage-minutes": { type: "string", default: "5" },
      "after-minutes": { type: "string", default: "5" },
      "after-max-minutes": { type: "string", default: "35" },
      "think-ms": { type: "string", default: "2000" },
      out: { type: "string" },
    },
  });
  if (!flags.sessions || !flags.notifications || !flags["compose-file"]?.length) {
    console.error("usage: node drill.mjs --sessions FILE --notifications DIR --compose-file F [--compose-file F2] [--out FILE]");
    process.exit(2);
  }
  const baseUrl = String(flags["base-url"]);
  const plan = {
    baselineMs: Number(flags["baseline-minutes"]) * 60_000,
    outageMs: Number(flags["outage-minutes"]) * 60_000,
    afterMs: Number(flags["after-minutes"]) * 60_000,
    afterMaxMs: Number(flags["after-max-minutes"]) * 60_000,
    thinkMs: Number(flags["think-ms"]),
  };
  const compose = ["compose", ...flags["compose-file"].flatMap((f) => ["-f", f])];
  /** @param {string[]} args */
  const docker = (...args) => run("docker", [...compose, ...args], { maxBuffer: 256 * 1024 * 1024 });
  /** @param {string} sql */
  const psql = async (sql) =>
    (await docker("exec", "-T", "postgres", "psql", "-U", "rehearsal", "-d", "rehearsal", "-v", "ON_ERROR_STOP=1", "-tAc", sql)).stdout.trim();
  const log = (/** @type {string} */ line) => console.log(`  ${new Date().toISOString().slice(11, 19)}  ${line}`);

  const { accounts } = JSON.parse(await readFile(String(flags.sessions), "utf8"));
  /** @param {number} index */
  const who = (index) => ({ baseUrl, cookie: accounts[index].cookie, address: clientAddressFor(index) });

  // The outage switch has to exist in both instances, or half the fleet
  // would stay healthy and the drill would measure a partial outage.
  const outageFile = (await docker("exec", "-T", "api1", "printenv", "MOCK_LLM_OUTAGE_FILE").catch(() => ({ stdout: "" }))).stdout.trim();
  const outageFile2 = (await docker("exec", "-T", "api2", "printenv", "MOCK_LLM_OUTAGE_FILE").catch(() => ({ stdout: "" }))).stdout.trim();
  if (!outageFile || outageFile !== outageFile2) {
    console.error("the API instances were not started with one MOCK_LLM_OUTAGE_FILE: nothing for the drill to switch");
    process.exit(2);
  }
  /** @param {boolean} on */
  const setOutage = (on) =>
    Promise.all(
      ["api1", "api2"].map((api) =>
        docker("exec", "-T", api, "sh", "-c", on ? `echo 529 > ${outageFile}` : `rm -f ${outageFile}`),
      ),
    );

  const runId = `drill-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  let phase = "baseline";
  let stopping = false;
  /** @type {AnalysisCall[]} */
  const analyses = [];
  /** @type {Read[]} */
  const reads = [];
  /** @type {{ id: string, owner: number, analysisId: string }[]} */
  const completedBefore = [];
  /** @type {{ id: string, owner: number }[]} */
  const uploadedDuring = [];
  /** @type {PromSample[]} */
  const prom = [];
  /** @type {AmSample[]} */
  const am = [];
  let pollErrors = 0;
  let next = 0;

  // ----- traffic: one analysing user, round-robin over the accounts so none
  // nears NFR-2.6's 10 an hour.
  async function analysingUser() {
    while (!stopping) {
      const owner = next % accounts.length;
      next += 1;
      const started = Date.now();
      /** @type {AnalysisCall} */
      const record = { at: started, ms: 0, status: null, code: null, retryAfter: null, message: null, documentId: null };
      try {
        const created = await call(who(owner), "/api/v1/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: drillContract(runId, next) }),
        });
        if (created.status !== 201) {
          Object.assign(record, { status: created.status }, await errorOf(created));
        } else {
          const { document } = /** @type {any} */ (await created.json());
          record.documentId = document.id;
          const inOutage = phase === "outage";
          if (inOutage) uploadedDuring.push({ id: document.id, owner });
          record.at = Date.now();
          const res = await call(who(owner), `/api/v1/documents/${document.id}/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          record.status = res.status;
          record.retryAfter = res.headers.get("retry-after");
          if (res.status === 200) {
            const { analysis } = /** @type {any} */ (await res.json());
            if (phase === "baseline") completedBefore.push({ id: document.id, owner, analysisId: analysis.id });
          } else {
            Object.assign(record, await errorOf(res));
          }
        }
      } catch {
        // A dropped connection: status stays null and fails a gate.
      }
      record.ms = Date.now() - record.at;
      analyses.push(record);
      await sleep(plan.thinkMs);
    }
  }

  // ----- traffic: one reader, once a second, alternating the history list
  // and a report finished before the outage, which must come back COMPLETED
  // and the same analysis it was.
  async function reader() {
    let i = 0;
    while (!stopping) {
      const t0 = Date.now();
      i += 1;
      const doc = completedBefore.length ? completedBefore[i % completedBefore.length] : null;
      /** @type {Read} */
      const read = { at: t0, kind: doc && i % 2 === 0 ? "report" : "list", status: null, ok: false };
      try {
        if (read.kind === "report" && doc) {
          const res = await call(who(doc.owner), `/api/v1/documents/${doc.id}`);
          read.status = res.status;
          const body = /** @type {any} */ (await res.json().catch(() => null));
          read.ok = res.status === 200 && body?.analysis?.id === doc.analysisId && body?.analysis?.status === "COMPLETED";
          if (!read.ok && res.status === 200) read.why = `latest analysis ${body?.analysis?.id} ${body?.analysis?.status}`;
        } else {
          const res = await call(who(i % accounts.length), "/api/v1/documents?limit=10");
          read.status = res.status;
          await res.arrayBuffer();
          read.ok = res.status === 200;
        }
      } catch {
        // dropped: ok stays false
      }
      reads.push(read);
      await sleep(1_000 - (Date.now() - t0));
    }
  }

  // ----- the alert pollers, for the whole run
  async function poller() {
    while (!stopping) {
      const t = Date.now();
      const [p, a] = await Promise.all([
        getJson(`${flags.prometheus}/api/v1/alerts`).catch(() => null),
        getJson(`${flags.alertmanager}/api/v2/alerts`).catch(() => null),
      ]);
      if (p) prom.push({ t, alerts: p.data.alerts.map((/** @type {any} */ x) => ({ alertname: x.labels.alertname, state: x.state })) });
      if (a)
        am.push({
          t,
          alerts: a.map((/** @type {any} */ x) => ({
            alertname: x.labels.alertname,
            route: x.labels.route,
            domain: x.labels.domain,
            state: x.status.state,
            inhibitedBy: x.status.inhibitedBy ?? [],
          })),
        });
      if (!p || !a) pollErrors += 1;
      await sleep(10_000 - (Date.now() - t));
    }
  }

  async function notifications() {
    /** @type {Notification[]} */
    const out = [];
    for (const receiver of ["page", "digest"]) {
      const text = await readFile(join(String(flags.notifications), `${receiver}.jsonl`), "utf8").catch(() => "");
      for (const line of text.split("\n").filter(Boolean)) out.push(parseNotification(JSON.parse(line)));
    }
    return out.sort((a, b) => a.at - b.at);
  }

  // Rows that existed before the outage, reduced to one digest: documents
  // with their text, analyses with their state and code, findings with
  // their excerpt. Taken again at the end, over the same rows.
  /** @param {number} cutoff */
  const snapshot = (cutoff) =>
    psql(`
      select md5(coalesce(string_agg(x, ',' order by x), '')) from (
        select 'd:' || id || ':' || md5("rawText") as x from "Document" where "createdAt" <= to_timestamp(${cutoff / 1000})
        union all
        select 'a:' || id || ':' || status || ':' || coalesce("errorCode", '') from "Analysis" where "createdAt" <= to_timestamp(${cutoff / 1000})
        union all
        select 'f:' || f.id || ':' || md5(f."clauseExcerpt") from "Finding" f join "Analysis" a on a.id = f."analysisId" where a."createdAt" <= to_timestamp(${cutoff / 1000})
      ) s`);

  log(`${runId}: ${accounts.length} accounts, an analysis about every ${((plan.thinkMs + 3_000) / 1000).toFixed(0)} s, a read every second`);
  const traffic = [analysingUser(), reader(), poller()];

  await sleep(plan.baselineMs);
  const rules = await getJson(`${flags.prometheus}/api/v1/rules`).catch(() => null);
  /** @type {{ name: string, lastEvaluationAt: number }[]} */
  const baselineRules = (rules?.data?.groups ?? []).map((/** @type {any} */ g) => ({
    name: String(g.name),
    lastEvaluationAt: Date.parse(g.lastEvaluation),
  }));
  // Nothing may be in flight or PENDING when the snapshot is taken, or a row
  // would legitimately change between the two digests.
  const cutoff = Date.now() - 10_000;
  await sleep(1_000);
  const snapshotBefore = await snapshot(cutoff).catch(() => null);

  log(`outage: every provider call answers 529 for ${plan.outageMs / 60_000} min`);
  const outageStartAt = Date.now();
  phase = "outage";
  await setOutage(true);
  await sleep(plan.outageMs - (Date.now() - outageStartAt));
  await setOutage(false);
  const outageEndAt = Date.now();
  phase = "after";
  log("outage over: the provider answers again");

  // Re-analyse documents uploaded during the outage, once analysis works
  // again: "Your document is saved — try again" has to be true.
  /** @type {{ status: number | null }[]} */
  const reanalyses = [];
  const reanalyse = (async () => {
    while (!stopping && !analyses.some((a) => a.at >= outageEndAt && a.status === 200)) await sleep(2_000);
    for (const doc of uploadedDuring.slice(0, DRILL.reanalyses)) {
      if (stopping) break;
      const res = await call(who(doc.owner), `/api/v1/documents/${doc.id}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => null);
      reanalyses.push({ status: res?.status ?? null });
      await res?.arrayBuffer().catch(() => undefined);
    }
  })();

  // Watch until quiet: nothing pending or firing in Prometheus, nothing in
  // Alertmanager, and every group that notified has notified its resolution.
  let observedUntilQuiet = false;
  let lastReport = 0;
  while (Date.now() - outageEndAt < plan.afterMaxMs) {
    await sleep(10_000);
    if (Date.now() - outageEndAt < plan.afterMs) continue;
    const lastProm = prom.at(-1);
    const lastAm = am.at(-1);
    const groups = notifiedGroups(await notifications(), outageStartAt);
    const quiet =
      lastProm !== undefined && lastProm.t > Date.now() - 20_000 && lastProm.alerts.length === 0 &&
      lastAm !== undefined && lastAm.t > Date.now() - 20_000 && lastAm.alerts.length === 0 &&
      groups.every((g) => g.resolved > 0);
    if (quiet) {
      observedUntilQuiet = true;
      break;
    }
    if (Date.now() - lastReport > 120_000) {
      lastReport = Date.now();
      log(`waiting for quiet: prometheus [${lastProm?.alerts.map((a) => `${a.alertname}:${a.state}`).join(" ") ?? "?"}], alertmanager [${lastAm?.alerts.map((a) => `${a.alertname}:${a.state}`).join(" ") ?? "?"}]`);
    }
  }
  await reanalyse;
  stopping = true;
  await Promise.all(traffic);
  // In-flight analyses have finished; give the API a moment to write them.
  await sleep(2_000);
  const endedAt = Date.now();

  const counts = (await psql(`select status, coalesce("errorCode", '-'), count(*) from "Analysis" group by 1, 2`))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("|"));
  /** @type {Record<string, number>} */
  const failedCodes = {};
  let pendingAtEnd = 0;
  let reaped = 0;
  for (const [status, code, n] of counts) {
    if (status === "PENDING") pendingAtEnd += Number(n);
    if (status === "FAILED") failedCodes[code] = (failedCodes[code] ?? 0) + Number(n);
    if (code === "STALE_ANALYSIS") reaped += Number(n);
  }
  const ids = uploadedDuring.map((d) => `'${d.id.replace(/[^a-z0-9]/gi, "")}'`).join(",");
  const present = ids ? Number(await psql(`select count(*) from "Document" where id in (${ids})`)) : 0;
  const snapshotAfter = await snapshot(cutoff).catch(() => null);

  // The breaker, as Prometheus saw it and as it logged itself.
  const range = await getJson(
    `${flags.prometheus}/api/v1/query_range?query=${encodeURIComponent("max(llm_circuit_state)")}&start=${(outageStartAt - 60_000) / 1000}&end=${(endedAt) / 1000}&step=15`,
  ).catch(() => null);
  /** @type {[number, number][]} */
  const breakerSeries = (range?.data?.result?.[0]?.values ?? []).map((/** @type {[number, string]} */ [t, v]) => [t * 1000, Number(v)]);
  const callsAt = async (/** @type {number} */ t) =>
    Number((await getJson(`${flags.prometheus}/api/v1/query?query=${encodeURIComponent("sum(llm_request_total)")}&time=${t / 1000}`).catch(() => null))?.data?.result?.[0]?.value?.[1] ?? NaN);
  const providerCallsDuringOutage = (await callsAt(outageEndAt)) - (await callsAt(outageStartAt));
  const { stdout: apiLogs } = await docker("logs", "--no-color", "api1", "api2").catch(() => ({ stdout: "" }));
  /** @type {Record<string, number>} */
  const breakerEvents = {};
  for (const line of apiLogs.split("\n")) {
    const json = line.slice(line.indexOf("{"));
    try {
      const entry = JSON.parse(json);
      if (typeof entry.alert === "string" && entry.alert.startsWith("circuit_")) breakerEvents[entry.alert] = (breakerEvents[entry.alert] ?? 0) + 1;
    } catch {
      // not a JSON log line
    }
  }

  const allNotifications = await notifications();
  const result = {
    runId,
    plan,
    baselineRules,
    startedAt,
    outageStartAt,
    outageEndAt,
    endedAt,
    analyses,
    reads,
    reanalyses,
    prom,
    am,
    pollErrors,
    notifications: allNotifications,
    observedUntilQuiet,
    database: { snapshotBefore, snapshotAfter, pendingAtEnd, reaped, failedCodes, outageDocuments: { uploaded: uploadedDuring.length, present } },
    breaker: {
      transitions: transitions(breakerSeries).map((x) => ({ minute: Number(((x.t - outageStartAt) / 60_000).toFixed(2)), to: x.to })),
      providerCallsDuringOutage,
      events: breakerEvents,
      fastRefusals: analyses.filter((a) => a.at >= outageStartAt && a.at < outageEndAt && a.code === "LLM_UNAVAILABLE" && a.ms < 500).length,
    },
  };
  const gates = gatesOutage(result);
  if (flags.out) await writeFile(String(flags.out), JSON.stringify({ ...result, gates }, null, 2));

  console.log(`\nprovider-outage drill ${runId}: ${minutes(endedAt - startedAt)}, outage ${minutes(outageEndAt - outageStartAt)}`);
  console.log(
    `  breaker: ${JSON.stringify(breakerEvents)}; llm_circuit_state changes (minutes from outage start): ${result.breaker.transitions.map((x) => `${x.minute}->${x.to}`).join(" ") || "none"}`,
  );
  console.log(`  provider calls during the outage: ${providerCallsDuringOutage}; analyses refused fast (< 0.5 s): ${result.breaker.fastRefusals}`);
  for (const n of allNotifications) {
    console.log(`  sent ${minutes(n.at - outageStartAt)} after outage start: ${n.receiver} ${n.status} ${JSON.stringify(n.groupLabels)} firing [${n.firing.join(", ")}] resolved [${n.resolved.join(", ")}]`);
  }
  for (const g of gates) console.log(`${g.pass ? "PASS" : "FAIL"}  ${g.name}\n      ${g.detail}`);
  process.exit(gates.every((g) => g.pass) ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
