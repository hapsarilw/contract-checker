import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { register } from "prom-client";
import { SPEC_METRICS, routeLabel } from "../../src/observability/metrics.js";
import { httpStatusLabel } from "../../src/services/llm/index.js";

/**
 * Step 67: "Write a test asserting every metric named in section 6.6 is
 * registered." Checked against the SRS TABLE ITSELF, parsed out of
 * docs/SRS.md, not only against metrics.js's own list: a metric renamed in
 * both the code and the code's list would otherwise pass.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** §6.6's table rows: `name` | type | labels. */
function specTable() {
  const srs = readFileSync(join(ROOT, "docs", "SRS.md"), "utf8");
  const section = srs.slice(
    srs.indexOf("### 6.6 Observability"),
    srs.indexOf("## 7. Frontend requirements"),
  );
  /** @type {Record<string, string[]>} */
  const metrics = {};
  for (const line of section.split("\n")) {
    const match = /^\| (`[^|]+`) \| (\w+) \| ([^|]+) \|$/.exec(line.trim());
    if (!match) continue;
    const names = [...match[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    const labels =
      match[3].trim() === "—"
        ? []
        : match[3].split(",").map((l) => l.trim().split(" ")[0]);
    for (const name of names) metrics[name] = labels;
  }
  return metrics;
}

describe("SRS §6.6 metrics are all registered, with the table's names and labels", () => {
  const table = specTable();

  it("the table parses to the 16 metric names it lists", () => {
    // 15 rows; db_pool_in_use / db_pool_waiting share one. dependency_up
    // joined at step 75, when readiness_failing moved onto it.
    expect(Object.keys(table)).toHaveLength(16);
    expect(Object.keys(table).sort()).toEqual(Object.keys(SPEC_METRICS).sort());
  });

  it.each(Object.entries(table))("%s is registered with labels %j", (name, labels) => {
    const metric = register.getSingleMetric(name);
    expect(metric, `${name} is not registered`).toBeDefined();
    // prom-client keeps the declared label names on the metric.
    const declared =
      /** @type {{ labelNames?: string[] }} */ (/** @type {unknown} */ (metric))
        .labelNames ?? [];
    expect([...declared].sort()).toEqual([...labels].sort());
  });

  it("types match the table (histogram / counter / gauge)", async () => {
    const srs = readFileSync(join(ROOT, "docs", "SRS.md"), "utf8");
    for (const name of Object.keys(table)) {
      const row = srs
        .split("\n")
        .find((line) => line.includes(`\`${name}\``) && line.startsWith("|"));
      const type = /\| (histogram|counter|gauge) \|/.exec(row ?? "")?.[1];
      const metric = /** @type {import("prom-client").Metric} */ (
        register.getSingleMetric(name)
      );
      const { type: actual } = await metric.get();
      expect(actual, name).toBe(type);
    }
  });
});

describe("routeLabel: the route PATTERN, never the raw path (cardinality)", () => {
  const req = (baseUrl, path) =>
    /** @type {import("express").Request} */ (
      /** @type {unknown} */ ({
        baseUrl,
        route: path === undefined ? undefined : { path },
      })
    );

  it.each([
    ["/api/v1/documents", "/:id", "/api/v1/documents/:id"],
    ["/api/v1/documents", "/:id/analyze", "/api/v1/documents/:id/analyze"],
    ["/api/v1/documents", "/", "/api/v1/documents"],
    ["", "/metrics", "/metrics"],
    ["/api", "/health", "/api/health"],
  ])("%s + %s -> %s", (baseUrl, path, expected) => {
    expect(routeLabel(req(baseUrl, path))).toBe(expected);
  });

  // Step 74: what the app-level error handler sees. Express has reset
  // baseUrl on the way out of the router; the route is still there.
  const leftRouter = (originalUrl, path) =>
    /** @type {import("express").Request} */ (
      /** @type {unknown} */ ({ baseUrl: "", originalUrl, route: { path } })
    );

  it.each([
    ["/api/v1/documents", "/", "/api/v1/documents"],
    ["/api/v1/documents?cursor=abc", "/", "/api/v1/documents"],
    [
      "/api/v1/documents/ckabc123/analyze",
      "/:id/analyze",
      "/api/v1/documents/:id/analyze",
    ],
    ["/api/v1/documents/ckabc123", "/:id", "/api/v1/documents/:id"],
    ["/api/health", "/api/health", "/api/health"],
    ["/metrics", "/metrics", "/metrics"],
  ])("after leaving its router: %s (route %s) -> %s", (url, path, expected) => {
    expect(routeLabel(leftRouter(url, path))).toBe(expected);
  });

  it("a request that never reached a route is 'unmatched', whatever its URL", () => {
    expect(routeLabel(req("", undefined))).toBe("unmatched");
  });
});

describe("httpStatusLabel (llm_request_total)", () => {
  it("success is 200", () => expect(httpStatusLabel("success")).toBe("200"));
  it("a provider error is its status", () =>
    expect(
      httpStatusLabel("failure", APIError.generate(529, {}, "overloaded", new Headers())),
    ).toBe("529"));
  it.each([
    ["our own abort", new APIUserAbortError()],
    ["the SDK's timeout", new APIConnectionTimeoutError()],
  ])("%s is 'timeout'", (_label, err) =>
    expect(httpStatusLabel("failure", err)).toBe("timeout"),
  );
  it("no response at all is 'network'", () =>
    expect(
      httpStatusLabel(
        "failure",
        Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      ),
    ).toBe("network"));
});
