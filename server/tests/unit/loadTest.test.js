import { describe, expect, it } from "vitest";
import {
  LIMITS,
  accountsNeeded,
  clientAddressFor,
  gatesTR21,
  gatesTR22,
  gatesTR23,
  parseMetrics,
  percentile,
  slopePerHour,
} from "../../../ops/load/load.mjs";

/**
 * ops/load/load.mjs's arithmetic and verdicts (BUILD-PLAN step 73). The
 * runs themselves take ten minutes to two hours against a live stack;
 * what is tested here is that their numbers are computed right and that a
 * gate cannot pass on missing data.
 */

const MB = 1048576;
const LIMIT = 512 * MB;
const gate = (gates, fragment) => gates.find((g) => g.name.includes(fragment));
/** @param {number} rss @param {number} [t] @param {string} [instance] */
const sample = (rss, t = 0, instance = "api1") => ({
  t,
  instance,
  rss,
  memoryLimit: LIMIT,
  poolInUse: 3,
  poolWaiting: 0,
});

describe("percentile (nearest rank)", () => {
  it("takes the value at the rank, not an interpolation", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });

  it("does not depend on input order", () => {
    expect(percentile([30, 10, 20, 40], 95)).toBe(40);
  });
});

describe("slopePerHour", () => {
  it("measures a steady climb", () => {
    const points = Array.from({ length: 13 }, (_, i) => ({
      t: i * 600_000,
      value: 100 * MB + i * MB,
    }));
    expect(slopePerHour(points) / MB).toBeCloseTo(6);
  });

  it("is zero for noise around a flat line", () => {
    const points = Array.from({ length: 60 }, (_, i) => ({
      t: i * 60_000,
      value: 200 * MB + (i % 2 ? MB : -MB),
    }));
    expect(Math.abs(slopePerHour(points) / MB)).toBeLessThan(0.2);
  });
});

describe("parseMetrics", () => {
  it("reads the four gauges from Prometheus text, labels or not", () => {
    const text = [
      "# HELP process_resident_memory_bytes Resident memory size in bytes.",
      "process_resident_memory_bytes 123456789",
      "memory_limit_bytes 536870912",
      'db_pool_in_use{pool="main"} 4',
      "db_pool_waiting 0",
    ].join("\n");
    expect(parseMetrics(text)).toEqual({
      rss: 123456789,
      memoryLimit: 536870912,
      poolInUse: 4,
      poolWaiting: 0,
    });
  });

  it("reports a missing gauge as null, never as zero", () => {
    expect(parseMetrics("").rss).toBeNull();
  });
});

describe("accounts and addresses", () => {
  it("sizes a run so no account passes 10 analyses an hour", () => {
    // 20 in flight, 25 s each, 10 minutes: 480 analyses, 48 accounts, +20%.
    expect(accountsNeeded({ concurrency: 20, minutes: 10, latencyMs: 25_000 })).toBe(58);
    // Two hours at 5: 720 an hour, 72 accounts per window, +20%.
    expect(accountsNeeded({ concurrency: 5, minutes: 120, latencyMs: 25_000 })).toBe(87);
  });

  it("gives every account its own private address", () => {
    const addresses = Array.from({ length: 1000 }, (_, i) => clientAddressFor(i));
    expect(new Set(addresses).size).toBe(1000);
    for (const a of addresses)
      expect(a).toMatch(/^10\.77\.\d+\.([1-9]\d?|1\d\d|2[0-4]\d|250)$/);
  });
});

describe("TR-21's gates", () => {
  const good = () => ({
    analyses: Array.from({ length: 100 }, () => ({ ms: 26_000, status: 200 })),
    samples: [sample(200 * MB), sample(210 * MB, 10_000, "api2")],
    peakInFlight: 20,
    concurrency: 20,
    memoryLimit: LIMIT,
  });

  it("all pass on a healthy run", () => {
    expect(gatesTR21(good()).every((g) => g.pass)).toBe(true);
  });

  it("fails p95 over 45 s", () => {
    const r = good();
    for (let i = 0; i < 6; i += 1) r.analyses[i].ms = 46_000;
    expect(gate(gatesTR21(r), "p95").pass).toBe(false);
  });

  it("fails one 500, and one dropped connection", () => {
    const r = good();
    r.analyses[0].status = 500;
    expect(gate(gatesTR21(r), "500s").pass).toBe(false);
    const d = good();
    /** @type {{ status: number | null }} */ (d.analyses[0]).status = null;
    expect(gate(gatesTR21(d), "500s").pass).toBe(false);
  });

  it("fails an instance above 80% of its limit", () => {
    const r = good();
    r.samples.push(sample(LIMIT * 0.81, 20_000, "api2"));
    expect(gate(gatesTR21(r), "memory").pass).toBe(false);
  });

  it("fails a pool that ever had a waiter", () => {
    const r = good();
    r.samples.push({ ...sample(200 * MB), poolWaiting: 1 });
    expect(gate(gatesTR21(r), "pool").pass).toBe(false);
  });

  it("fails a run that never reached the concurrency it claims", () => {
    expect(gate(gatesTR21({ ...good(), peakInFlight: 12 }), "in flight").pass).toBe(
      false,
    );
  });

  it("cannot pass memory or pool without samples", () => {
    const gates = gatesTR21({ ...good(), samples: [] });
    expect(gate(gates, "memory").pass).toBe(false);
    expect(gate(gates, "pool").pass).toBe(false);
  });
});

describe("TR-22's gates", () => {
  /** @param {(minute: number) => number} rssAt */
  const soak = (rssAt, minutes = 120) => {
    const samples = [];
    const database = [];
    for (let minute = 0; minute <= minutes; minute += 1) {
      const t = minute * 60_000;
      samples.push(sample(rssAt(minute), t, "api1"), sample(rssAt(minute), t, "api2"));
      database.push({ t, connections: 14 });
    }
    return {
      analyses: [{ ms: 25_000, status: 200 }],
      samples,
      database,
      startedAt: 0,
      memoryLimit: LIMIT,
      minutes,
    };
  };

  it("passes flat memory, and ignores the warm-up climb", () => {
    // A steep climb while warming up (caches, JIT, the pool filling): judged
    // over the whole run it would read as a leak of well over the allowance.
    const warmingThenFlat = (m) => (m < 10 ? 60 * MB + m * 24 * MB : 300 * MB);
    expect(gate(gatesTR22(soak(warmingThenFlat)), "flat").pass).toBe(true);
  });

  it("fails a slow leak that 5% over two hours would catch", () => {
    // 0.25 MB a minute: 15 MB/h, allowed 12.8 MB/h at 512 MB.
    expect(gate(gatesTR22(soak((m) => 200 * MB + m * 0.25 * MB)), "flat").pass).toBe(
      false,
    );
  });

  it("fails a growing connection count", () => {
    const r = soak(() => 200 * MB);
    r.database = r.database.map((d, i) => ({
      ...d,
      connections: 14 + Math.floor(i / 20),
    }));
    expect(gate(gatesTR22(r), "connection").pass).toBe(false);
  });

  it("fails a run that stopped short of its duration", () => {
    expect(
      gate(gatesTR22({ ...soak(() => 200 * MB, 60), minutes: 120 }), "ran for").pass,
    ).toBe(false);
  });

  it("warm-up is the stated ten minutes", () => {
    expect(LIMITS.soakWarmupMs).toBe(600_000);
  });
});

describe("TR-23's gates", () => {
  const good = () => ({
    uploads: [
      ...Array.from({ length: 30 }, () => ({ status: 503, code: "SERVER_BUSY" })),
      ...Array.from({ length: 20 }, () => ({ status: 422, code: "DOCUMENT_TOO_LONG" })),
    ],
    samples: [sample(300 * MB)],
    containers: [
      {
        name: "api1",
        oomKilled: false,
        restarts: 0,
        running: true,
        cgroup: { "memory.swap.max": 0 },
      },
      {
        name: "api2",
        oomKilled: false,
        restarts: 0,
        running: true,
        cgroup: { "memory.swap.max": 0 },
      },
    ],
    readyAfter: true,
    memoryLimit: LIMIT,
  });

  it("passes when the cap refuses the overflow and nothing dies", () => {
    expect(gatesTR23(good()).every((g) => g.pass)).toBe(true);
  });

  it("fails when nothing was refused: the cap did not engage", () => {
    const r = good();
    r.uploads = r.uploads.map(() => ({
      status: 201,
      code: /** @type {string} */ (/** @type {unknown} */ (null)),
    }));
    expect(gate(gatesTR23(r), "SERVER_BUSY").pass).toBe(false);
  });

  it("fails an OOM kill or a restart", () => {
    const r = good();
    r.containers[1].oomKilled = true;
    expect(gate(gatesTR23(r), "OOM").pass).toBe(false);
    const s = good();
    s.containers[0].restarts = 1;
    expect(gate(gatesTR23(s), "OOM").pass).toBe(false);
  });

  it("fails any other 5xx, but not the 503 it expects", () => {
    const r = good();
    r.uploads[0] = { status: 500, code: "INTERNAL_ERROR" };
    expect(gate(gatesTR23(r), "other 5xx").pass).toBe(false);
  });

  it("cannot pass OOM without inspecting the containers", () => {
    expect(gate(gatesTR23({ ...good(), containers: [] }), "OOM").pass).toBe(false);
  });

  it("is not a valid test at all when an instance could swap", () => {
    // Step 73's first run: RSS past the limit, no OOM kill, because the
    // kernel swapped 272 MB out instead.
    const r = good();
    r.containers[0].cgroup = { "memory.swap.max": 536870912 };
    expect(gate(gatesTR23(r), "valid test").pass).toBe(false);
    expect(
      gate(
        gatesTR23({
          ...good(),
          containers: good().containers.map((c) => ({ ...c, cgroup: {} })),
        }),
        "valid test",
      ).pass,
    ).toBe(false);
  });

  it("counts an instance that is no longer running as died", () => {
    const r = good();
    r.containers[1].running = false;
    expect(gate(gatesTR23(r), "OOM").pass).toBe(false);
  });
});
