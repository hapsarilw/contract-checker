import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { register } from "prom-client";
import "../../src/observability/metrics.js";

/**
 * Step 67's dashboards are code, so they are tested like code: every query
 * may name only metrics this server actually registers, and only labels
 * those metrics actually have. A dashboard querying a renamed metric does
 * not error; it shows "No data", which on the quality dashboard reads as
 * "nothing is wrong".
 */

const DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "ops",
  "dashboards",
);
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".json"));

const FUNCTIONS = new Set([
  "sum",
  "max",
  "min",
  "avg",
  "count",
  "rate",
  "increase",
  "irate",
  "histogram_quantile",
  "time",
  "scalar",
  "by",
  "without",
  "on",
  "ignoring",
  "and",
  "or",
  "unless",
  "clamp_min",
]);
const HISTOGRAM_SUFFIXES = ["_bucket", "_sum", "_count"];

/** @param {string} name */
function metricFor(name) {
  const exact = register.getSingleMetric(name);
  if (exact) return { metric: exact, extraLabels: [] };
  for (const suffix of HISTOGRAM_SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const base = register.getSingleMetric(name.slice(0, -suffix.length));
    if (base) return { metric: base, extraLabels: suffix === "_bucket" ? ["le"] : [] };
  }
  return null;
}

/** @param {import("prom-client").Metric} metric */
const labelsOf = (metric) =>
  /** @type {{ labelNames?: string[] }} */ (/** @type {unknown} */ (metric)).labelNames ??
  [];

/** Every (expr, metrics named, labels used) in a dashboard file. */
function queries(file) {
  const dashboard = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  return dashboard.panels.flatMap((panel) =>
    panel.targets.map((/** @type {{ expr: string }} */ t) => ({
      panel: panel.title,
      expr: t.expr,
    })),
  );
}

describe.each(FILES)("%s", (file) => {
  it("is a dashboard with panels, each with a title, a description and at least one query", () => {
    const dashboard = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    expect(dashboard.uid).toMatch(/^clausecheck-/);
    expect(dashboard.panels.length).toBeGreaterThan(0);
    for (const panel of dashboard.panels) {
      expect(panel.title).toBeTruthy();
      expect(panel.description).toBeTruthy();
      expect(panel.targets.length).toBeGreaterThan(0);
    }
  });

  it.each(
    /** @type {[string, string][]} */ (queries(file).map((q) => [q.panel, q.expr])),
  )("%s: names only registered metrics, with only their labels", (_panel, expr) => {
    // Strip string literals, then find label matchers and grouping labels.
    const withoutStrings = expr.replace(/"[^"]*"/g, '""');
    const matcherBlocks = [...withoutStrings.matchAll(/([a-z_][a-z0-9_]*)\{([^}]*)\}/g)];
    const grouping = [
      ...withoutStrings.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g),
    ].flatMap((m) =>
      m[1]
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const bare = withoutStrings
      .replace(/\{[^}]*\}/g, "")
      .replace(/\b(?:by|without)\s*\([^)]*\)/g, "")
      .replace(/\[[^\]]*\]/g, "");
    const identifiers = [...bare.matchAll(/\b([a-z_][a-z0-9_]*)\b/g)].map((m) => m[1]);
    const metricNames = identifiers.filter((id) => !FUNCTIONS.has(id));

    expect(metricNames.length).toBeGreaterThan(0);
    /** @type {Set<string>} */
    const allowedLabels = new Set(["instance", "job", "le"]);
    for (const name of metricNames) {
      const found = metricFor(name);
      expect(found, `${name} is not a registered metric`).not.toBeNull();
      if (!found) continue;
      for (const label of [...labelsOf(found.metric), ...found.extraLabels]) {
        allowedLabels.add(label);
      }
    }
    for (const [, name, body] of matcherBlocks) {
      const found = metricFor(name);
      expect(found, `${name} is not a registered metric`).not.toBeNull();
      if (!found) continue;
      const own = new Set([...labelsOf(found.metric), ...found.extraLabels]);
      for (const [, label] of body.matchAll(/([a-z_]+)\s*(?:=~|!=|!~|=)/g)) {
        expect(own.has(label), `${name} has no label "${label}"`).toBe(true);
      }
    }
    for (const label of grouping) {
      expect(allowedLabels.has(label), `grouping by unknown label "${label}"`).toBe(true);
    }
  });
});

describe("the quality dashboard carries PRD §11's thresholds", () => {
  const dashboard = JSON.parse(readFileSync(join(DIR, "product-quality.json"), "utf8"));
  const steps = (title) =>
    dashboard.panels
      .find((p) => p.title.startsWith(title))
      .fieldConfig.defaults.thresholds.steps.map((s) => s.value)
      .filter((v) => v !== null);

  it("discard rate: 5% target, 10% review (§11.1)", () =>
    expect(steps("Discard rate")).toEqual([0.05, 0.1]));
  it("risk drift: 25% review (§11.1)", () =>
    expect(steps("Rule/model risk drift")).toEqual([0.25]));
  it("user-visible errors: 2% (§11.2)", () =>
    expect(steps("Analyses ending in an error")).toEqual([0.02]));
  it("spend: the 50/80/100% alert thresholds (FR-5.4)", () =>
    expect(steps("Spend against ceiling")).toEqual([0.5, 0.8, 1]));
});
