import { createHash, timingSafeEqual } from "node:crypto";
import { Counter, Gauge, Histogram, collectDefaultMetrics, register } from "prom-client";
import config from "../config.js";
import { pool } from "../lib/prisma.js";
import { checkPostgres, checkRedis } from "../lib/readinessChecks.js";
import { getRequestId } from "../middleware/requestId.js";
import { uploadsInFlight } from "../middleware/uploadConcurrency.js";
import { getCircuitState } from "../services/llm/circuitBreaker.js";
import { getSpendState } from "../services/spend.js";
import logger from "./logger.js";
// Registered by their own modules (they predate this file and own their
// read-at-scrape logic); imported here so that loading this module is enough
// for every metric §6.6 and Appendix C name to exist. reaper.js joined the
// list at step 68, when an alert rule referenced stale_pending_analyses and
// the catalogue test found nothing registered under that name.
import "../jobs/jobRuns.js";
import "../jobs/reaper.js";
import "../lib/email.js";

/**
 * SRS §6.6's metrics, every one of them, with the table's exact names and
 * labels. tests/unit/metrics.test.js asserts the whole table is
 * registered, so a metric cannot be quietly renamed or dropped.
 *
 * WHERE THEY ARE EXPOSED: A DECISION, recorded here as step 67 asks.
 * §6.6 says "exported on an internal port", but Render and Railway (§8's
 * candidates) expose exactly one port per web service, so a second port
 * would be unreachable by any scraper outside the container. The choices
 * were a second port (unreachable), a push exporter (a second moving part
 * that fails silently when it stops pushing), or an AUTHENTICATED route on
 * the one port. It is the route: `GET /metrics`, requiring
 * `Authorization: Bearer <METRICS_TOKEN>`. Every hosted Prometheus-
 * compatible scraper (Grafana Cloud, Datadog's OpenMetrics check, a
 * self-hosted Prometheus) supports a bearer token. The token is required
 * in production (config.js), so a deployment cannot ship with metrics
 * either missing or public; unset outside production, the route answers
 * 404 as if it did not exist.
 *
 * PER-INSTANCE, AND WHAT THAT MEANS. Counters and histograms are this
 * process's own; the scraper sums them across instances. The gauges that
 * describe SHARED state (spend, the circuit breaker, the job table) read
 * that state at scrape time, so every instance reports the same value:
 * aggregate them with max(), never sum(). The dashboards do.
 *
 * CARDINALITY: every label value comes from a closed set. `route` is the
 * matched route PATTERN ("/api/v1/documents/:id"), never the raw path,
 * which would mint a series per document id; `error_code` is §4.2's
 * closed table. Nothing about a person or a document is ever a label.
 */

// Process metrics (memory, CPU, event loop lag, GC) for the operational
// dashboard's memory panel. Once per registry, however often this module
// is re-imported under vi.resetModules().
if (!register.getSingleMetric("process_cpu_user_seconds_total")) collectDefaultMetrics();

/**
 * @template {import("prom-client").Metric} M
 * @param {string} name
 * @param {() => M} create
 * @returns {M}
 */
function once(name, create) {
  return /** @type {M} */ (register.getSingleMetric(name)) ?? create();
}

/** Seconds. Upper buckets reach the 90 s analyze ceiling (FR-3.10). */
const REQUEST_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 90,
];
const ANALYSIS_BUCKETS = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120];

export const httpRequestDuration = once(
  "http_request_duration_seconds",
  () =>
    new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request duration, by matched route pattern, method and status (SRS §6.6).",
      labelNames: ["route", "method", "status"],
      buckets: REQUEST_BUCKETS,
    }),
);

export const analysisDuration = once(
  "analysis_duration_seconds",
  () =>
    new Histogram({
      name: "analysis_duration_seconds",
      help: "Wall time of an analysis from its PENDING insert to a terminal state, by outcome.",
      labelNames: ["outcome"],
      buckets: ANALYSIS_BUCKETS,
    }),
);

export const analysisTotal = once(
  "analysis_total",
  () =>
    new Counter({
      name: "analysis_total",
      help:
        "Analyses reaching a terminal state, by outcome (completed, failed) and error_code " +
        '("none" when completed). Refusals before an analysis exists (quota, spend, ' +
        "verification) are requests, not analyses, and are not counted here.",
      labelNames: ["outcome", "error_code"],
    }),
);

export const analysisFindingsTotal = once(
  "analysis_findings_total",
  () =>
    new Counter({
      name: "analysis_findings_total",
      help: "Findings shown to users (verified and persisted), by severity.",
      labelNames: ["severity"],
    }),
);

export const analysisFindingsDiscardedTotal = once(
  "analysis_findings_discarded_total",
  () =>
    new Counter({
      name: "analysis_findings_discarded_total",
      help:
        "Findings discarded by excerpt verification (§5.3): quotes not found in the document. " +
        "The numerator of the discard rate PRD §11 watches.",
    }),
);

export const analysisRiskDriftTotal = once(
  "analysis_risk_drift_total",
  () =>
    new Counter({
      name: "analysis_risk_drift_total",
      help:
        "Completed analyses where the rule-derived overall risk (shown) differs from the " +
        "model's own claim (kept only to measure this, FR-3.9 / PRD D7).",
      labelNames: ["rule_risk", "model_risk"],
    }),
);

export const llmTokensTotal = once(
  "llm_tokens_total",
  () =>
    new Counter({
      name: "llm_tokens_total",
      help: "Provider tokens, by direction (input, output) and requested model.",
      labelNames: ["direction", "model"],
    }),
);

export const llmRequestTotal = once(
  "llm_request_total",
  () =>
    new Counter({
      name: "llm_request_total",
      help:
        "Provider call ATTEMPTS (a retried call counts each attempt, as the circuit breaker " +
        'does), by outcome (success, failure) and http_status ("timeout" or "network" ' +
        "when there was no response).",
      labelNames: ["outcome", "http_status"],
    }),
);

export const llmSpendUsdMonth = once(
  "llm_spend_usd_month",
  () =>
    new Gauge({
      name: "llm_spend_usd_month",
      help:
        "Estimated provider spend this calendar month, in USD, read at scrape time from the " +
        "shared spend meter (FR-5.4). Absent, not 0, when the figure is unavailable.",
      labelNames: ["model"],
      async collect() {
        try {
          const state = await getSpendState();
          this.reset();
          if (state.usd !== null)
            this.set({ model: config.llmParamProfile.model }, state.usd);
        } catch (err) {
          logScrapeFailure("llm_spend_usd_month", err);
        }
      },
    }),
);

/**
 * Not in §6.6's table: the denominator the quality dashboard's "spend
 * against ceiling" panel needs. Exported as a metric so the dashboard
 * reads the configured ceiling rather than a number typed into it that
 * would drift the first time MONTHLY_SPEND_CEILING_USD changes.
 */
export const llmSpendCeilingUsd = once(
  "llm_spend_ceiling_usd",
  () =>
    new Gauge({
      name: "llm_spend_ceiling_usd",
      help: "The configured monthly provider spend ceiling, in USD (MONTHLY_SPEND_CEILING_USD, FR-5.4).",
      collect() {
        this.set(config.MONTHLY_SPEND_CEILING_USD);
      },
    }),
);

export const llmCircuitState = once(
  "llm_circuit_state",
  () =>
    new Gauge({
      name: "llm_circuit_state",
      help: "The provider circuit breaker (FR-3.12), read from Redis at scrape time: 1 tripped (open, or half-open waiting for a successful trial), 0 closed.",
      async collect() {
        const state = await getCircuitState();
        this.set(state.open ? 1 : 0);
      },
    }),
);

/**
 * How long one dependency check may take at scrape time before it counts
 * as down. Prometheus gives up on a scrape after 10 s by default; two
 * checks in parallel, each bounded here, keep an outage from turning
 * into a failed scrape, which would hide every other metric with it.
 */
export const DEPENDENCY_CHECK_TIMEOUT_MS = 3_000;

/**
 * @param {Promise<import("../lib/readinessChecks.js").CheckResult>} check
 * @returns {Promise<boolean>}
 */
async function upWithin(check) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), DEPENDENCY_CHECK_TIMEOUT_MS);
  });
  try {
    const result = /** @type {{ ok: boolean }} */ (await Promise.race([check, timedOut]));
    return result.ok;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * FR-4.7's readiness, as a metric (step 75). `readiness_failing` used to
 * count answers to GET /api/ready, which only existed because the
 * platform's health check called it. The platform now probes /api/health
 * instead (ops/render/*.render.yaml says why: Render restarts an instance
 * that fails its health check for 60 s, so a readiness health check turns
 * a shared dependency's outage into every instance restarting), and the
 * alert would have gone silent with nobody calling /api/ready. Measured at
 * scrape time, the same checks the route runs, like llm_circuit_state.
 */
export const dependencyUp = once(
  "dependency_up",
  () =>
    new Gauge({
      name: "dependency_up",
      help: "FR-4.7's readiness checks, run at scrape time: 1 if this instance reaches the dependency, 0 if not (or not within 3 s).",
      labelNames: ["dependency"],
      async collect() {
        const [postgres, redis] = await Promise.all([
          upWithin(checkPostgres()),
          upWithin(checkRedis()),
        ]);
        this.set({ dependency: "postgres" }, postgres ? 1 : 0);
        this.set({ dependency: "redis" }, redis ? 1 : 0);
      },
    }),
);

export const dbPoolInUse = once(
  "db_pool_in_use",
  () =>
    new Gauge({
      name: "db_pool_in_use",
      help: "Database connections checked out of this instance's pool right now.",
      collect() {
        this.set(pool.totalCount - pool.idleCount);
      },
    }),
);

export const dbPoolWaiting = once(
  "db_pool_waiting",
  () =>
    new Gauge({
      name: "db_pool_waiting",
      help: "Queries on this instance waiting for a free pool connection. Above 0 for long is saturation.",
      collect() {
        this.set(pool.waitingCount);
      },
    }),
);

export const uploadsInFlightGauge = once(
  "uploads_in_flight",
  () =>
    new Gauge({
      name: "uploads_in_flight",
      help: "Uploads being processed on this instance (FR-2.12's concurrency cap applies to it).",
      collect() {
        this.set(uploadsInFlight());
      },
    }),
);

/**
 * Appendix C's two Sev-1 alerts (step 68). Both count something the
 * pipeline structurally prevents, which is exactly why they are counted:
 * the value of a defensive assertion is that it fires when the structure
 * has been broken by a change nobody realised could break it. A series
 * that sits at 0 forever is this working.
 *
 * "any occurrence" is the condition for both, so the alert is on
 * `increase() > 0` and there is no threshold to tune.
 */
export const unverifiedExcerptDisplayedTotal = once(
  "unverified_excerpt_displayed_total",
  () =>
    new Counter({
      name: "unverified_excerpt_displayed_total",
      help:
        "Findings whose excerpt failed re-verification against the document at the moment it " +
        "was about to be served (§5.3, PRD §11.1). Any nonzero value is a Sev-1: the " +
        "verification defence has failed. Nothing is served when this increments.",
      labelNames: ["path"],
    }),
);

export const crossUserAccessTotal = once(
  "cross_user_access_total",
  () =>
    new Counter({
      name: "cross_user_access_total",
      help:
        "Documents loaded whose owner is not the session's subject, caught by the defensive " +
        "assertion in lib/defensiveAssertions.js (FR-1.5). Any nonzero value is a Sev-1. " +
        "Nothing is served when this increments.",
    }),
);

/**
 * Appendix C's `memory_high` is "RSS > 80% of LIMIT", and the limit is a
 * deploy-time fact no Node process can discover for itself (a container's
 * cgroup limit is not process_resident_memory_bytes's business). Exported
 * as a gauge from configuration, like llm_spend_ceiling_usd, so the alert
 * rule divides two series this server publishes instead of carrying a
 * number someone typed into a dashboard and then changed the plan.
 *
 * Required in production (config.js): with no limit the alert cannot fire
 * at all, and an alert that silently never fires is worse than none.
 */
export const memoryLimitBytes = once(
  "memory_limit_bytes",
  () =>
    new Gauge({
      name: "memory_limit_bytes",
      help: "The instance's configured memory limit in bytes (MEMORY_LIMIT_BYTES); absent when unset.",
      collect() {
        if (config.MEMORY_LIMIT_BYTES === undefined) this.reset();
        else this.set(config.MEMORY_LIMIT_BYTES);
      },
    }),
);

/**
 * @param {string} metric
 * @param {unknown} err
 */
function logScrapeFailure(metric, err) {
  // A failing collect must not take the rest of the scrape with it.
  logger.warn(
    { metric, err: { message: err instanceof Error ? err.message : String(err) } },
    "could not read a metric at scrape time",
  );
}

/**
 * The matched route PATTERN, never the raw path (see CARDINALITY above).
 * A request that never reached a route (a 404, or one refused by the CSRF
 * guard or a limiter before routing) is "unmatched".
 *
 * AFTER A ROUTER HAS BEEN LEFT, Express has reset req.baseUrl to "", while
 * req.route still holds the matched route. That is the state the app-level
 * error handler sees, and the state "finish" sees for any request that
 * failed through it: until step 74 every such request was labelled "/" (a
 * 500 on POST /api/v1/documents counted as POST /), found by the error
 * tracker's test. So when baseUrl is empty, the mount point is recovered
 * from the request's own path, minus as many trailing segments as the
 * route pattern has. Every route here is a plain pattern (no wildcards or
 * optional segments), for which that is exact.
 *
 * @param {import("express").Request} req
 */
export function routeLabel(req) {
  if (!req.route) return "unmatched";
  const routePath = req.route.path === "/" ? "" : req.route.path;
  let base = req.baseUrl;
  if (!base && typeof req.route.path === "string") {
    const segments = String(req.originalUrl ?? req.url ?? "")
      .split("?")[0]
      .split("/")
      .filter(Boolean);
    const routeSegments = routePath.split("/").filter(Boolean).length;
    base =
      segments.length > routeSegments
        ? `/${segments.slice(0, segments.length - routeSegments).join("/")}`
        : "";
  }
  const path = `${base}${routePath}`;
  return path === "" ? "/" : path;
}

/**
 * Express middleware: times every request into http_request_duration_seconds.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
export function httpMetricsMiddleware(req, res, next) {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    end({ route: routeLabel(req), method: req.method, status: String(res.statusCode) });
  });
  next();
}

/** @param {string} value */
const digest = (value) => createHash("sha256").update(value).digest();

/**
 * GET /metrics. Constant-time token comparison (hashing both sides first
 * makes the lengths equal, which timingSafeEqual requires, without leaking
 * the token's length through an early return).
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function metricsHandler(req, res) {
  const token = config.METRICS_TOKEN;
  if (!token) {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "Not found.", requestId: getRequestId() },
    });
    return;
  }
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!timingSafeEqual(digest(presented), digest(token))) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="metrics"');
    res.status(401).json({
      error: {
        code: "UNAUTHENTICATED",
        message: "A valid metrics token is required.",
        requestId: getRequestId(),
      },
    });
    return;
  }
  res.setHeader("Content-Type", register.contentType);
  res.end(await register.metrics());
}

/**
 * FR-7.9's violation reports (step 75), by directive, from
 * routes/cspReport.js. The label is one of lib/cspReports.js's known
 * directives or "other", never what the client sent, so a poster cannot
 * grow the series without bound. Not alerted on: during rollout a report is
 * something to read, and most will be browser extensions, not the app.
 */
export const cspViolationTotal = once(
  "csp_violation_total",
  () =>
    new Counter({
      name: "csp_violation_total",
      help: "Content-Security-Policy violations browsers reported (FR-7.9), by effective directive.",
      labelNames: ["directive"],
    }),
);

/**
 * The metrics Appendix C's alert rules read that §6.6's table does not
 * name. ops/alerts/alerts.yml may only reference these and SPEC_METRICS
 * (plus prom-client's process metrics); tests/unit/alertCatalogue.test.js
 * enforces that.
 */
export const ALERT_METRICS = Object.freeze({
  unverified_excerpt_displayed_total: ["path"],
  cross_user_access_total: [],
  memory_limit_bytes: [],
  backup_verify_failed: [],
  stale_pending_analyses: [],
  llm_spend_ceiling_usd: [],
});

/**
 * Every metric SRS §6.6's table names, as the table spells them. The test
 * checks each is registered; the dashboards test checks every query uses
 * only these (and prom-client's process metrics).
 */
export const SPEC_METRICS = Object.freeze({
  http_request_duration_seconds: ["route", "method", "status"],
  analysis_duration_seconds: ["outcome"],
  analysis_total: ["outcome", "error_code"],
  analysis_findings_total: ["severity"],
  analysis_findings_discarded_total: [],
  analysis_risk_drift_total: ["rule_risk", "model_risk"],
  llm_tokens_total: ["direction", "model"],
  llm_spend_usd_month: ["model"],
  llm_request_total: ["outcome", "http_status"],
  llm_circuit_state: [],
  db_pool_in_use: [],
  db_pool_waiting: [],
  dependency_up: ["dependency"],
  uploads_in_flight: [],
  retention_job_last_success_timestamp: ["job"],
  email_send_total: ["type", "outcome"],
});
