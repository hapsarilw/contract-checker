import { describe, expect, it } from "vitest";
import {
  AddressBudget,
  DRILL,
  FAULTS,
  drillContract,
  gatesOutage,
  notifiedGroups,
  parseNotification,
  pendingGroupsAtEnd,
  stalls,
  transitions,
} from "../../../ops/drills/provider-outage/drill.mjs";
import { ERROR_CODES } from "../../src/lib/errorCodes.js";

/**
 * ops/drills/provider-outage/drill.mjs's verdicts (BUILD-PLAN step 75, PRD
 * §9 DoD item 3). The drill itself takes half an hour against a live
 * stack; what is tested here is that each gate reads the evidence right,
 * and that none of them can pass on missing evidence.
 */

const MIN = 60_000;
const START = 10 * MIN;
const END = START + 5 * MIN;
const gate = (gates, fragment) => {
  const found = gates.find((g) => g.name.includes(fragment));
  if (!found) throw new Error(`no gate named like ${fragment}`);
  return found;
};

/** @param {number} at @param {Partial<import("../../../ops/drills/provider-outage/drill.mjs").AnalysisCall>} [over] */
const ok = (at, over = {}) => ({
  at,
  ms: 3_000,
  status: 200,
  code: null,
  retryAfter: null,
  message: null,
  documentId: "d",
  ...over,
});
/** @param {number} at */
const degraded = (at) => ({
  at,
  ms: 20,
  status: 503,
  code: "LLM_UNAVAILABLE",
  retryAfter: "60",
  message: DRILL.degradedMessage,
  documentId: "d",
});

/** @param {number} at @param {string} status @param {string} domain @param {string[]} firing @param {string[]} [resolved] */
const note = (at, status, domain, firing, resolved = []) => ({
  at,
  receiver: "page",
  groupKey: `{}/{route="page"}:{domain="${domain}", route="page"}`,
  status,
  firing,
  resolved,
  groupLabels: { route: "page", domain },
});

const POLLS = Array.from(
  { length: Math.floor((32 * MIN) / 10_000) },
  (_, i) => START - 7 * MIN + 30_000 + i * 10_000,
);
/** @param {number} t */
const firingAt = (t) => t >= START + 2 * MIN && t < END + 15 * MIN;

/**
 * A run that passes every gate; each test breaks one thing.
 * @returns {Parameters<typeof gatesOutage>[0]}
 */
function passingRun() {
  const analyses = [
    ok(START - 2 * MIN),
    ok(START - MIN),
    ...Array.from({ length: 10 }, (_, i) => degraded(START + (i + 1) * 20_000)),
    ok(END + 70_000),
  ];
  const reads = Array.from({ length: 900 }, (_, i) => ({
    at: START - 3 * MIN + i * 1_000,
    kind: /** @type {const} */ ("list"),
    status: 200,
    ok: true,
  }));
  return {
    startedAt: START - 7 * MIN,
    outageStartAt: START,
    outageEndAt: END,
    baselineRules: ["clausecheck-provider", "clausecheck-quality"].map((name) => ({
      name,
      lastEvaluationAt: START - 2 * MIN,
    })),
    analyses,
    reads,
    reanalyses: [{ status: 200 }, { status: 200 }],
    // A poll every 10 s, as the drill makes them: analysis_failure_rate
    // firing from two minutes into the outage until 15 minutes after it.
    prom: POLLS.map((t) => ({
      t,
      alerts: firingAt(t)
        ? [{ alertname: "analysis_failure_rate", state: "firing" }]
        : [],
    })),
    am: POLLS.map((t) => ({
      t,
      alerts: firingAt(t)
        ? [
            {
              alertname: "analysis_failure_rate",
              route: "page",
              domain: "provider",
              state: "active",
              inhibitedBy: [],
            },
          ]
        : [],
    })),
    notifications: [
      note(START + 2 * MIN, "firing", "provider", ["analysis_failure_rate"]),
      note(END + 18 * MIN, "resolved", "provider", [], ["analysis_failure_rate"]),
    ],
    database: {
      snapshotBefore: "a1b2c3d4e5f6a7b8",
      snapshotAfter: "a1b2c3d4e5f6a7b8",
      pendingAtEnd: 0,
      reaped: 0,
      failedCodes: { LLM_UNAVAILABLE: 10 },
      outageDocuments: { uploaded: 10, present: 10 },
    },
    observedUntilQuiet: true,
  };
}

describe("the drill's constants come from the product, not a copy", () => {
  it("the degraded-mode message and Retry-After are errorCodes.js's own", () => {
    expect(DRILL.degradedMessage).toBe(ERROR_CODES.LLM_UNAVAILABLE.message);
    expect(DRILL.retryAfter).toBe(String(ERROR_CODES.LLM_UNAVAILABLE.retryAfter));
    expect(DRILL.degradedMessage).toMatch(/document is saved/);
  });

  it("the drill's document clears MIN_DOCUMENT_WORDS (200) with room, and differs every time", () => {
    const words = drillContract("r", 1).split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThan(220);
    expect(drillContract("r", 1)).not.toBe(drillContract("r", 2));
  });
});

describe("gatesOutage", () => {
  it("a run with the evidence passes every gate", () => {
    const gates = gatesOutage(passingRun());
    expect(gates.filter((g) => !g.pass)).toEqual([]);
    expect(gates).toHaveLength(11);
  });

  it("validity: a host that stalls makes the whole run invalid, whatever else it measured", () => {
    // The first run's laptop slept 2.4 minutes into the outage: the reader
    // and the poller both stopped for up to 15 minutes at a time.
    const slept = passingRun();
    slept.reads = slept.reads.filter(
      (x) => x.at < START + 2 * MIN || x.at > START + 4 * MIN,
    );
    const g = gate(gatesOutage(slept), "valid run");
    expect(g.pass).toBe(false);
    expect(g.detail).toMatch(/INVALID RUN/);

    const pollsStopped = passingRun();
    pollsStopped.prom = pollsStopped.prom.filter(
      (p) => p.t < START + MIN || p.t > START + 3 * MIN,
    );
    expect(gate(gatesOutage(pollsStopped), "valid run").pass).toBe(false);
  });

  it("baseline: an alert firing before the outage fails it, and so does not having looked", () => {
    const dirty = passingRun();
    dirty.prom[0].alerts.push({ alertname: "retention_job_stale", state: "firing" });
    expect(gate(gatesOutage(dirty), "clean baseline").pass).toBe(false);
    expect(gate(gatesOutage(dirty), "clean baseline").detail).toMatch(
      /retention_job_stale/,
    );

    const unobserved = passingRun();
    unobserved.prom = unobserved.prom.filter((s) => s.t >= START);
    expect(gate(gatesOutage(unobserved), "clean baseline").pass).toBe(false);

    const notified = passingRun();
    notified.notifications.unshift(
      note(START - MIN, "firing", "jobs", ["backup_verify_failed"]),
    );
    expect(gate(gatesOutage(notified), "clean baseline").pass).toBe(false);
  });

  it("baseline: a rule group not yet evaluated on baseline traffic means the baseline was not observed", () => {
    // The first run's lesson: the five-minute quality group first evaluated
    // during the outage, and an alert the mock had been causing all along
    // looked like the outage's.
    const early = passingRun();
    early.baselineRules[1].lastEvaluationAt = early.startedAt + 30_000;
    const g = gate(gatesOutage(early), "clean baseline");
    expect(g.pass).toBe(false);
    expect(g.detail).toMatch(/clausecheck-quality/);

    const none = passingRun();
    none.baselineRules = [];
    expect(gate(gatesOutage(none), "clean baseline").pass).toBe(false);
  });

  it("degraded mode: a 503 without Retry-After, or with another message, is not the stated error", () => {
    for (const change of [
      { retryAfter: null },
      { message: "Service unavailable" },
      { code: "INTERNAL" },
      { status: 500 },
    ]) {
      const run = passingRun();
      Object.assign(run.analyses[3], change);
      expect(
        gate(gatesOutage(run), "degraded-mode error").pass,
        JSON.stringify(change),
      ).toBe(false);
    }
  });

  it("degraded mode: too few failed analyses during the outage is not evidence", () => {
    const run = passingRun();
    run.analyses = run.analyses.filter((a) => a.status === 200 || a.at < START + 30_000);
    expect(gate(gatesOutage(run), "degraded-mode error").pass).toBe(false);
  });

  it("nothing else failed: a 500 or a dropped connection anywhere fails it, and so does LLM_UNAVAILABLE outside the outage", () => {
    const fiveHundred = passingRun();
    fiveHundred.analyses.push(ok(END + 5 * MIN, { status: 500, code: "INTERNAL" }));
    expect(gate(gatesOutage(fiveHundred), "nothing else failed").pass).toBe(false);

    const dropped = passingRun();
    dropped.analyses.push(ok(START - MIN, { status: null }));
    expect(gate(gatesOutage(dropped), "nothing else failed").pass).toBe(false);

    const beforeOutage = passingRun();
    beforeOutage.analyses.push(degraded(START - 30_000));
    expect(gate(gatesOutage(beforeOutage), "nothing else failed").pass).toBe(false);

    // After recovery, an LLM_UNAVAILABLE means the breaker did not close.
    const afterRecovery = passingRun();
    afterRecovery.analyses.push(degraded(END + 10 * MIN));
    expect(gate(gatesOutage(afterRecovery), "nothing else failed").pass).toBe(false);
  });

  it("reads: one failed or altered read fails it, and so do too few reads during the outage", () => {
    const failed = passingRun();
    failed.reads[400] = { ...failed.reads[400], status: 503, ok: false };
    expect(gate(gatesOutage(failed), "reads are unaffected").pass).toBe(false);

    const sparse = passingRun();
    sparse.reads = sparse.reads.filter((x) => x.at < START || x.at >= END);
    expect(gate(gatesOutage(sparse), "reads are unaffected").pass).toBe(false);
  });

  it("data: a changed digest fails it, and so does a missing one", () => {
    const changed = passingRun();
    changed.database.snapshotAfter = "ffffffffffffffff";
    expect(gate(gatesOutage(changed), "no data loss").pass).toBe(false);

    const missing = passingRun();
    missing.database.snapshotBefore = null;
    missing.database.snapshotAfter = null;
    expect(gate(gatesOutage(missing), "no data loss").pass).toBe(false);
  });

  it("outage uploads: one missing document, or one failed re-analysis, fails it", () => {
    const lost = passingRun();
    lost.database.outageDocuments.present = 9;
    expect(gate(gatesOutage(lost), "uploaded during the outage").pass).toBe(false);

    const retryFails = passingRun();
    retryFails.reanalyses.push({ status: 503 });
    expect(gate(gatesOutage(retryFails), "uploaded during the outage").pass).toBe(false);

    const untried = passingRun();
    untried.reanalyses = [];
    expect(gate(gatesOutage(untried), "uploaded during the outage").pass).toBe(false);
  });

  it("stuck analyses: a PENDING row, a reaped one, or another failure code fails it", () => {
    for (const change of [
      { pendingAtEnd: 1 },
      { reaped: 1 },
      { failedCodes: { LLM_UNAVAILABLE: 9, INTERNAL: 1 } },
      { pendingAtEnd: null },
    ]) {
      const run = passingRun();
      Object.assign(run.database, change);
      expect(
        gate(gatesOutage(run), "no analysis stuck").pass,
        JSON.stringify(change),
      ).toBe(false);
    }
  });

  it("recovery: no success after the outage, or a late one, fails it", () => {
    const never = passingRun();
    never.analyses = never.analyses.filter((a) => a.at < END);
    expect(gate(gatesOutage(never), "recovers").pass).toBe(false);

    const late = passingRun();
    late.analyses[late.analyses.length - 1].at = END + DRILL.recoveryMs;
    expect(gate(gatesOutage(late), "recovers").pass).toBe(false);
  });

  it("ONE alert: a second group notifying fails it, however the first one went", () => {
    const run = passingRun();
    run.notifications.push(note(START + 2 * MIN, "firing", "platform", ["api_5xx_rate"]));
    const g = gate(gatesOutage(run), "ONE alert");
    expect(g.pass).toBe(false);
    expect(g.detail).toMatch(/api_5xx_rate/);
    expect(g.detail).toMatch(/analysis_failure_rate/);
  });

  it("ONE alert: a group still active in Alertmanager when the run ended counts, sent or not", () => {
    const run = passingRun();
    run.am.push({
      t: END + 21 * MIN,
      alerts: [
        {
          alertname: "analysis_latency_p95",
          route: "digest",
          domain: "quality",
          state: "active",
          inhibitedBy: [],
        },
      ],
    });
    expect(gate(gatesOutage(run), "ONE alert").pass).toBe(false);
    expect(gate(gatesOutage(run), "ONE alert").detail).toMatch(/digest\/quality/);

    // Suppressed is not waiting to notify.
    const inhibited = passingRun();
    inhibited.am.push({
      t: END + 21 * MIN,
      alerts: [
        {
          alertname: "api_5xx_rate",
          route: "page",
          domain: "platform",
          state: "suppressed",
          inhibitedBy: ["x"],
        },
      ],
    });
    expect(gate(gatesOutage(inhibited), "ONE alert").pass).toBe(true);
  });

  it("ONE alert: no alert at all fails it, and so does a run that stopped watching too early", () => {
    const silent = passingRun();
    silent.notifications = [];
    expect(gate(gatesOutage(silent), "ONE alert").pass).toBe(false);

    const cut = passingRun();
    cut.observedUntilQuiet = false;
    expect(gate(gatesOutage(cut), "ONE alert").pass).toBe(false);
  });

  it("the one alert must be the provider's, on the pager", () => {
    const platform = passingRun();
    platform.notifications = [
      note(START + 2 * MIN, "firing", "platform", ["api_5xx_rate"]),
    ];
    for (const sample of platform.am)
      sample.alerts = sample.alerts.map((a) => ({
        ...a,
        alertname: "api_5xx_rate",
        domain: "platform",
      }));
    expect(gate(gatesOutage(platform), "ONE alert").pass).toBe(true);
    expect(gate(gatesOutage(platform), "points at the cause").pass).toBe(false);
  });
});

describe("the database fault (step 75): the same drill, Postgres stopped", () => {
  /** A database outage that went as it should, built from the passing provider run. */
  function databaseRun() {
    const run = passingRun();
    run.fault = "database";
    run.analyses = run.analyses.map((a) =>
      a.status === 200
        ? a
        : {
            ...a,
            code: "DATABASE_UNAVAILABLE",
            retryAfter: "30",
            message: FAULTS.database.statedMessage,
          },
    );
    // Reads are refused while it is down, with the stated error.
    run.reads = run.reads.map((x) =>
      x.at >= START && x.at < END
        ? { ...x, status: 503, ok: false, code: "DATABASE_UNAVAILABLE" }
        : x,
    );
    run.database = {
      ...run.database,
      reaped: 1,
      failedCodes: { STALE_ANALYSIS: 1 },
      outageDocuments: { uploaded: 0, present: 0 },
    };
    run.reanalyses = [];
    for (const n of run.notifications) {
      n.groupKey = n.groupKey.replace("provider", "platform");
      n.groupLabels = { ...n.groupLabels, domain: "platform" };
    }
    for (const sample of run.am)
      sample.alerts = sample.alerts.map((a) => ({
        ...a,
        alertname: "api_5xx_rate",
        domain: "platform",
      }));
    return run;
  }

  it("states its own code and message, from errorCodes.js", () => {
    expect(FAULTS.database.code).toBe("DATABASE_UNAVAILABLE");
    expect(FAULTS.database.statedMessage).toBe(ERROR_CODES.DATABASE_UNAVAILABLE.message);
    expect(FAULTS.database.retryAfter).toBe("30");
    expect(FAULTS.provider.statedMessage).toBe(ERROR_CODES.LLM_UNAVAILABLE.message);
  });

  it("a database outage that went as it should passes every gate", () => {
    expect(gatesOutage(databaseRun()).filter((g) => !g.pass)).toEqual([]);
  });

  it("reads: refused as stated during the outage is right; before it, or as a 500, is not", () => {
    const early = databaseRun();
    early.reads[0] = {
      ...early.reads[0],
      status: 503,
      ok: false,
      code: "DATABASE_UNAVAILABLE",
    };
    expect(gate(gatesOutage(early), "reads are refused").pass).toBe(false);

    const unstated = databaseRun();
    const i = unstated.reads.findIndex((x) => x.at >= START && x.at < END);
    unstated.reads[i] = { ...unstated.reads[i], status: 500, code: "INTERNAL" };
    expect(gate(gatesOutage(unstated), "reads are refused").pass).toBe(false);

    // And a "database outage" that never refused a read did not happen.
    const unfelt = databaseRun();
    unfelt.reads = unfelt.reads.map((x) => ({ ...x, status: 200, ok: true, code: null }));
    expect(gate(gatesOutage(unfelt), "reads are refused").pass).toBe(false);
  });

  it("the one analysis in flight may be left to the reaper, and no more; a provider outage leaves none", () => {
    const two = databaseRun();
    two.database.reaped = 2;
    expect(gate(gatesOutage(two), "no analysis stuck").pass).toBe(false);

    const provider = passingRun();
    provider.database.reaped = 1;
    expect(gate(gatesOutage(provider), "no analysis stuck").pass).toBe(false);
  });

  it("a request in flight when the fault began may fail as stated; one that ended before it may not", () => {
    /** @param {number} at @param {number} ms */
    const refused = (at, ms) => ({
      ...degraded(at),
      ms,
      code: "DATABASE_UNAVAILABLE",
      retryAfter: "30",
      message: FAULTS.database.statedMessage,
    });
    const inFlight = databaseRun();
    inFlight.analyses.push(refused(START - 1_840, 3_051));
    expect(gate(gatesOutage(inFlight), "nothing else failed").pass).toBe(true);

    const before = databaseRun();
    before.analyses.push(refused(START - 5_000, 3_000));
    expect(gate(gatesOutage(before), "nothing else failed").pass).toBe(false);
  });

  it("the cause is the platform's: a provider page for a database outage would send the operator the wrong way", () => {
    const wrong = databaseRun();
    for (const n of wrong.notifications)
      n.groupLabels = { ...n.groupLabels, domain: "provider" };
    expect(gate(gatesOutage(wrong), "points at the cause").pass).toBe(false);
  });
});

describe("AddressBudget: the drill's own traffic stays inside NFR-2.6's 100 per 15 minutes", () => {
  it("counts each address's requests over the last 15 minutes, and forgets older ones", () => {
    const budget = new AddressBudget({ limit: 90, windowMs: 15 * MIN });
    for (let k = 0; k < 90; k += 1) budget.use("10.77.0.1", k * 1_000);
    expect(budget.left("10.77.0.1", 90_000)).toBe(0);
    expect(budget.left("10.77.0.2", 90_000)).toBe(90);
    // Fifteen minutes after the first use, it no longer counts.
    expect(budget.left("10.77.0.1", 15 * MIN)).toBe(1);
    expect(budget.left("10.77.0.1", 16 * MIN + 30_000)).toBe(90);
  });

  it("keeps any 15-minute window under the limiter's 100, with room for the analysing user", () => {
    expect(new AddressBudget().limit).toBeLessThan(100);
  });
});

describe("the evidence helpers", () => {
  it("stalls: gaps over the limit, in order, and none for a steady loop", () => {
    expect(stalls([0, 1_000, 2_000, 40_000, 41_000, 100_000], 30_000)).toEqual([
      { from: 2_000, ms: 38_000 },
      { from: 41_000, ms: 59_000 },
    ]);
    expect(stalls([3_000, 1_000, 2_000], 30_000)).toEqual([]);
  });

  it("parseNotification reads the recorder's line: firing and resolved alerts named separately", () => {
    const n = parseNotification({
      at: "2026-10-05T10:00:00.000Z",
      body: {
        receiver: "page",
        status: "firing",
        groupKey: "k",
        groupLabels: { route: "page", domain: "provider" },
        alerts: [
          { status: "firing", labels: { alertname: "circuit_open" } },
          { status: "resolved", labels: { alertname: "analysis_failure_rate" } },
        ],
      },
    });
    expect(n).toEqual({
      at: Date.parse("2026-10-05T10:00:00.000Z"),
      receiver: "page",
      groupKey: "k",
      status: "firing",
      firing: ["circuit_open"],
      resolved: ["analysis_failure_rate"],
      groupLabels: { route: "page", domain: "provider" },
    });
  });

  it("notifiedGroups: one group however many messages, counted from its first FIRING message", () => {
    const groups = notifiedGroups(
      [
        note(START + 2 * MIN, "firing", "provider", ["analysis_failure_rate"]),
        note(START + 7 * MIN, "firing", "provider", [
          "analysis_failure_rate",
          "circuit_open",
        ]),
        note(
          END + 18 * MIN,
          "resolved",
          "provider",
          [],
          ["analysis_failure_rate", "circuit_open"],
        ),
        // A resolution of something that fired before the window opened is
        // not a new alert.
        note(START + MIN, "resolved", "jobs", [], ["backup_verify_failed"]),
        note(START - MIN, "firing", "jobs", ["backup_verify_failed"]),
      ],
      START,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      firing: 2,
      resolved: 1,
      alertnames: ["analysis_failure_rate", "circuit_open"],
    });
  });

  it("pendingGroupsAtEnd: only ACTIVE alerts in the last poll, grouped as alertmanager.yml groups them", () => {
    expect(
      pendingGroupsAtEnd([
        {
          t: 1,
          alerts: [
            {
              alertname: "a",
              route: "page",
              domain: "platform",
              state: "active",
              inhibitedBy: [],
            },
          ],
        },
        {
          t: 2,
          alerts: [
            {
              alertname: "b",
              route: "page",
              domain: "provider",
              state: "active",
              inhibitedBy: [],
            },
            {
              alertname: "c",
              route: "page",
              domain: "provider",
              state: "active",
              inhibitedBy: [],
            },
            {
              alertname: "d",
              route: "page",
              domain: "platform",
              state: "suppressed",
              inhibitedBy: ["x"],
            },
          ],
        },
      ]),
    ).toEqual(["page/provider"]);
    expect(pendingGroupsAtEnd([])).toEqual([]);
  });

  it("transitions: every change of the breaker gauge, and nothing for a steady one", () => {
    expect(
      transitions([
        [0, 0],
        [15, 1],
        [30, 1],
        [45, 0],
        [60, 1],
      ]),
    ).toEqual([
      { t: 15, to: 1 },
      { t: 45, to: 0 },
      { t: 60, to: 1 },
    ]);
    expect(
      transitions([
        [0, 1],
        [15, 1],
      ]),
    ).toEqual([]);
  });
});
