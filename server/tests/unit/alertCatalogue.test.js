import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { register } from "prom-client";
import { parse } from "yaml";
import { ALERT_METRICS, SPEC_METRICS } from "../../src/observability/metrics.js";

/**
 * BUILD-PLAN step 68, item 1: every alert in SRS Appendix C defined as code,
 * with its threshold, severity, destination, owner and runbook.
 *
 * This is the half that promtool cannot check. `npm run test:alerts` runs the
 * rules' EXPRESSIONS against synthetic series; this checks the CATALOGUE
 * against the specification: that all nineteen are there, that none has been
 * promoted to paging or quietly demoted, that each names an owner and a
 * procedure, and that the routing config sends them where the table says.
 *
 * Appendix C is parsed out of docs/SRS.md rather than copied here. A copy
 * would be a second source of truth, and the failure it invites is the
 * quietest one available: the spec says page, the rule says digest, and both
 * "match" because they match each other.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ALERTS_DIR = join(ROOT, "ops", "alerts");

/**
 * Appendix C's table: name → { severity, route, runbook }. `runbook` is null
 * where the table leaves it blank ("—"), which is the gap step 69 fills.
 */
function appendixC() {
  const srs = readFileSync(join(ROOT, "docs", "SRS.md"), "utf8");
  const section = srs.slice(srs.indexOf("## Appendix C"), srs.indexOf("## Appendix D"));
  /** @type {Record<string, { severity: string, route: string, runbook: string | null }>} */
  const alerts = {};
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    // | `name` | condition | sev | route | runbook |
    if (cells.length !== 7) continue;
    const name = /^`([a-z_0-9]+)`$/.exec(cells[1])?.[1];
    if (!name) continue;
    const runbook = /`([a-z-]+)`/.exec(cells[5])?.[1] ?? null;
    alerts[name] = { severity: cells[3], route: cells[4], runbook };
  }
  return alerts;
}

/** Every alert defined as code: the Prometheus rules plus the CI-sourced one. */
function catalogue() {
  const rules = parse(readFileSync(join(ALERTS_DIR, "alerts.yml"), "utf8"));
  const ci = parse(readFileSync(join(ALERTS_DIR, "ci-alerts.yml"), "utf8"));
  /** @type {{ name: string, source: string, group: string | null, expr: string | null, for: string | null, labels: Record<string, string>, annotations: Record<string, string> }[]} */
  const defined = [];
  for (const group of rules.groups) {
    for (const rule of group.rules) {
      defined.push({
        name: rule.alert,
        source: "prometheus",
        group: group.name,
        expr: rule.expr,
        for: rule.for ?? null,
        labels: rule.labels ?? {},
        annotations: rule.annotations ?? {},
      });
    }
  }
  for (const alert of ci.alerts) {
    defined.push({
      name: alert.alert,
      source: alert.source,
      group: null,
      expr: null,
      for: null,
      labels: alert.labels ?? {},
      annotations: alert.annotations ?? {},
    });
  }
  return defined;
}

const SPEC = appendixC();
const DEFINED = catalogue();
const BY_NAME = new Map(DEFINED.map((alert) => [alert.name, alert]));

/**
 * The runbooks Appendix C leaves blank, plus the one it marks "adapted".
 * Step 68's own instructions say to note these so step 69 does not miss
 * them; this list is that note, made to fail if it drifts.
 */
const RUNBOOK_GAPS = {
  db_pool_saturated: "missing",
  analysis_latency_p95: "missing",
  memory_high: "missing",
  email_delivery_failures: "missing",
  cross_user_access: "adapted",
};

describe("Appendix C is defined as code, completely and without drift", () => {
  it("parses the specification's table to 19 alerts", () => {
    expect(Object.keys(SPEC)).toHaveLength(19);
  });

  it("defines exactly those 19, and no others", () => {
    expect([...BY_NAME.keys()].sort()).toEqual(Object.keys(SPEC).sort());
    expect(DEFINED).toHaveLength(19);
  });

  it.each(Object.entries(SPEC))("%s carries the table's severity and destination", (name, spec) => {
    const alert = /** @type {NonNullable<ReturnType<typeof BY_NAME.get>>} */ (BY_NAME.get(name));
    expect(alert.labels.severity).toBe(spec.severity);
    expect(alert.labels.route).toBe(spec.route);
  });

  it("routes every Sev-1 and Sev-2 to a page and every Sev-3 to the digest", () => {
    // Appendix C's closing note: alerts that page are deliberately few,
    // because one that fires without a required action trains the operator
    // to ignore the ones that matter. Asserted as a RULE, not row by row, so
    // a new alert cannot be added at Sev-3 and wired to the pager.
    for (const alert of DEFINED) {
      const expected = alert.labels.severity === "3" ? "digest" : "page";
      expect(alert.labels.route, alert.name).toBe(expected);
    }
  });

  it.each(DEFINED.map((alert) => [alert.name]))("%s names an owner and a domain", (name) => {
    const alert = /** @type {NonNullable<ReturnType<typeof BY_NAME.get>>} */ (BY_NAME.get(name));
    expect(alert.labels.owner).toBeTruthy();
    expect(alert.labels.domain).toBeTruthy();
  });

  it.each(DEFINED.map((alert) => [alert.name]))("%s says what happened and what to read", (name) => {
    const alert = /** @type {NonNullable<ReturnType<typeof BY_NAME.get>>} */ (BY_NAME.get(name));
    expect(alert.annotations.summary).toBeTruthy();
    // Long enough to be a sentence about consequences rather than a restated
    // metric name: what an operator reads at 3am is this.
    expect(alert.annotations.description.length).toBeGreaterThan(80);
    expect(alert.annotations.runbook).toBeTruthy();
    expect(alert.annotations.runbook_url).toBe(`docs/runbooks/${alert.annotations.runbook}.md`);
  });

  it("uses the runbook the table names, wherever the table names one", () => {
    for (const [name, spec] of Object.entries(SPEC)) {
      if (!spec.runbook) continue;
      const alert = /** @type {NonNullable<ReturnType<typeof BY_NAME.get>>} */ (BY_NAME.get(name));
      expect(alert.annotations.runbook, name).toBe(spec.runbook);
    }
  });

  it("marks exactly the alerts whose runbook Appendix C left blank or borrowed", () => {
    // Step 69 writes these four and adapts the fifth. If a runbook is
    // written, this test fails until the marker is cleared; if a sixth gap
    // appears, it fails until it is listed. Either way nobody is left
    // holding a page with no procedure and no record that there isn't one.
    const marked = Object.fromEntries(
      DEFINED.filter((alert) => alert.annotations.runbook_state).map((alert) => [
        alert.name,
        alert.annotations.runbook_state,
      ]),
    );
    expect(marked).toEqual(RUNBOOK_GAPS);
  });

  it("the four blank ones are blank in the specification too", () => {
    for (const [name, state] of Object.entries(RUNBOOK_GAPS)) {
      if (state !== "missing") continue;
      expect(SPEC[name].runbook, name).toBeNull();
    }
  });
});

describe("the rules only read metrics this server publishes", () => {
  const KNOWN = new Set([
    ...Object.keys(SPEC_METRICS),
    ...Object.keys(ALERT_METRICS),
    // prom-client's process metrics.
    "process_resident_memory_bytes",
  ]);
  const FUNCTIONS = new Set([
    "sum", "max", "min", "avg", "count", "rate", "increase", "irate", "time",
    "histogram_quantile", "by", "without", "on", "ignoring", "group_left",
    "group_right", "and", "or", "unless", "vector", "absent", "scalar",
  ]);
  const SUFFIXES = ["_bucket", "_sum", "_count"];

  /** @param {string} name */
  const resolve = (name) =>
    KNOWN.has(name) ||
    SUFFIXES.some((suffix) => name.endsWith(suffix) && KNOWN.has(name.slice(0, -suffix.length)));

  it.each(DEFINED.filter((alert) => alert.expr).map((alert) => [alert.name, alert.expr]))(
    "%s",
    (name, expr) => {
      const identifiers = /** @type {string} */ (expr)
        .replace(/"[^"]*"/g, '""')
        .replace(/\{[^}]*\}/g, "")
        .replace(/\b(?:by|without)\s*\([^)]*\)/g, "")
        .replace(/\[[^\]]*\]/g, "")
        .match(/\b([a-z_][a-z0-9_]*)\b/g) ?? [];
      const metrics = identifiers.filter((id) => !FUNCTIONS.has(id));
      expect(metrics.length, `${name} reads no metric`).toBeGreaterThan(0);
      for (const metric of metrics) {
        expect(resolve(metric), `${name} reads unknown metric "${metric}"`).toBe(true);
        const base = SUFFIXES.reduce(
          (acc, suffix) => (acc.endsWith(suffix) ? acc.slice(0, -suffix.length) : acc),
          metric,
        );
        // And registered for real, not merely listed in a constant.
        expect(register.getSingleMetric(base), `${metric} is not registered`).toBeDefined();
      }
    },
  );
});

describe("every alert has a promtool case that fires it", () => {
  // A rule with no test is a rule nobody has seen work. promtool reports
  // passing tests, not missing ones, so this is what makes the suite's
  // coverage of the catalogue checkable.
  const fired = new Set();
  for (const file of readdirSync(join(ALERTS_DIR, "tests"))) {
    const suite = parse(readFileSync(join(ALERTS_DIR, "tests", file), "utf8"));
    for (const test of suite.tests ?? []) {
      for (const assertion of test.alert_rule_test ?? []) {
        if ((assertion.exp_alerts ?? []).length > 0) fired.add(assertion.alertname);
      }
    }
  }

  it.each(DEFINED.filter((alert) => alert.expr).map((alert) => [alert.name]))(
    "%s fires in at least one case",
    (name) => {
      expect(fired.has(name)).toBe(true);
    },
  );

  it("and no test names an alert that does not exist", () => {
    for (const name of fired) expect(BY_NAME.has(name)).toBe(true);
  });
});

describe("alertmanager.yml sends them where Appendix C says", () => {
  const config = parse(readFileSync(join(ALERTS_DIR, "alertmanager.yml"), "utf8"));

  it("has a receiver for each destination, and defaults to the quiet one", () => {
    expect(config.receivers.map((/** @type {{ name: string }} */ r) => r.name).sort()).toEqual([
      "digest",
      "page",
    ]);
    // An alert that arrives without a route label is a mistake in a rule,
    // and a mistake must not wake anyone.
    expect(config.route.receiver).toBe("digest");
  });

  it.each([
    ["page", "page"],
    ["digest", "digest"],
  ])("routes route=%s to the %s receiver", (label, receiver) => {
    const child = config.route.routes.find((/** @type {{ matchers: string[] }} */ r) =>
      r.matchers.includes(`route = ${label}`),
    );
    expect(child).toBeDefined();
    expect(child.receiver).toBe(receiver);
  });

  it("groups by destination and cause, never by alert name", () => {
    // group_by: [alertname] would put every alert in a group of its own,
    // which is the pager storm PRD §9's DoD item 3 forbids.
    for (const route of [config.route, ...config.route.routes]) {
      expect(route.group_by).toEqual(["route", "domain"]);
      expect(route.group_by).not.toContain("alertname");
    }
  });

  it("digests wait longer than pages before saying anything", () => {
    const page = config.route.routes.find((/** @type {{ receiver: string }} */ r) => r.receiver === "page");
    const digest = config.route.routes.find((/** @type {{ receiver: string }} */ r) => r.receiver === "digest");
    expect(page.group_wait).toBe("30s");
    expect(digest.group_wait).toBe("15m");
    expect(digest.repeat_interval).toBe("24h");
  });

  it("never suppresses a Sev-1", () => {
    // The two Sev-1s are the reason the rest of the catalogue exists. No
    // inhibition may target them, however much noise is happening around
    // them.
    const sev1 = DEFINED.filter((alert) => alert.labels.severity === "1").map((a) => a.name);
    expect(sev1).toHaveLength(2);
    for (const rule of config.inhibit_rules) {
      for (const matcher of rule.target_matchers) {
        for (const name of sev1) {
          expect(matcher, `${name} must never be inhibited`).not.toContain(name);
        }
      }
    }
  });

  it("suppresses the symptoms of a provider outage so it pages once", () => {
    const provider = config.inhibit_rules.find((/** @type {{ source_matchers: string[] }} */ r) =>
      r.source_matchers.includes("alertname = circuit_open"),
    );
    expect(provider).toBeDefined();
    for (const symptom of ["analysis_failure_rate", "api_5xx_rate", "analysis_latency_p95"]) {
      expect(provider.target_matchers.join(" ")).toContain(symptom);
    }
  });

  it("every alert named in an inhibition is a real alert", () => {
    for (const rule of config.inhibit_rules) {
      for (const matcher of [...rule.source_matchers, ...rule.target_matchers]) {
        const names = /** @type {string} */ (matcher)
          .replace(/^alertname\s*(?:=~|=)\s*"?|"?$/g, "")
          .split("|");
        for (const name of names) expect(BY_NAME.has(name), name).toBe(true);
      }
    }
  });
});
