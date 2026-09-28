# Operations: metrics, dashboards, traces, synthetic checks

How to connect SRS §6.6's observability to a monitoring stack. The code side is done and tested. The accounts are not: **no metrics backend, trace collector or synthetic-monitoring provider has been chosen yet.** Each section below says what to set up once one is.

## Metrics

The API serves every §6.6 metric at **`GET /metrics`**, on the same port as everything else, behind a bearer token.

```yaml
# Prometheus (or Grafana Agent / Alloy) scrape config
scrape_configs:
  - job_name: clausecheck-api
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/secrets/clausecheck-metrics-token   # METRICS_TOKEN
    static_configs:
      - targets: ["api.example.com"]
```

**Why a route and not a separate port.** §6.6 says "an internal port", but Render and Railway expose exactly one port per service, so a second port couldn't be scraped from outside. A push exporter was the other option, but it's one more moving part that fails silently when it stops pushing. `server/src/observability/metrics.js` has the full reasoning.

**`METRICS_TOKEN` is required in production.** The server refuses to boot without it, because without it nothing can be scraped and no Appendix C alert can ever fire. Keep it in the platform's secret store, and use a different token for each environment. Outside production, if it isn't set, `/metrics` answers 404.

**Behind a load balancer, one scrape reaches one instance.** Counters and histograms are per process, so the scraper needs to reach every instance (the platform's service discovery), or totals will undercount. The gauges that describe shared state (`llm_spend_usd_month`, `llm_spend_ceiling_usd`, `llm_circuit_state`, `retention_job_last_success_timestamp`, `backup_verify_failed`) read that state at scrape time, so every instance reports the same value. Aggregate those with `max()`, never `sum()`. The dashboards already do.

## Dashboards

`dashboards/operational.json` and `dashboards/product-quality.json` are Grafana dashboard JSON. To import one: Dashboards → New → Import → upload the file, then pick the Prometheus data source when asked (`${DS_PROMETHEUS}`).

- **Operational:** request rate, error rate, latency percentiles, database pool and memory, plus uploads in flight, provider calls, the circuit breaker, job staleness and email. SLO lines are PRD §14.1's own.
- **Product quality:** analyses per day, outcome mix, error share, discard rate, risk-drift ratio, findings by severity, and spend against the ceiling. Thresholds are PRD §11's own (discard rate 5% target and 10% review, drift 25%, errors 2%) and FR-5.4's spend alerts (50, 80 and 100%).

`server/tests/unit/dashboards.test.js` checks that every query names only metrics the server registers, with only their real labels, and that the PRD thresholds are on the panels. A dashboard that queries a renamed metric doesn't error; it shows "No data", which on the quality dashboard reads as "nothing is wrong".

## Traces

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP collector. For an authenticated one, also set `OTEL_EXPORTER_OTLP_HEADERS`, which the exporter reads itself. When it isn't set, tracing is off and costs nothing.

Spans: `document.extract` (at upload, where extraction happens), then `analysis` with its children `analysis.prompt`, `analysis.provider_call`, `analysis.validate`, `analysis.verify` and `analysis.persist`. Every span carries `clausecheck.request_id`. Spans carry ids, counts and error codes only. They never carry document text, and a failed span records the error code, never the message. `server/tests/integration/observability.test.js` checks this with a planted phrase.

## Synthetic uptime checks

§6.6 asks for checks against `/api/health` and a full login → list round trip, **from at least two regions, every minute.** `synthetics/login-list.mjs` is that check. It has no dependencies and exits non-zero on failure, so any provider that runs a Node script can use it (Checkly, Grafana Synthetic Monitoring, or a scheduler of your own). An integration test runs it against the real app.

**Set-up:**

1. Create the monitoring account in the app: register it and verify its email. Nothing else is needed; it never analyses anything.
2. On the API, set all three: `SYNTHETIC_ACCOUNT_EMAIL` (that account), `SYNTHETIC_CHECK_TOKEN` (≥ 32 random bytes) and `SYNTHETIC_CHECK_IPS` (the provider's published checker addresses, comma-separated, CIDR allowed). The server refuses to boot with only some of them set.
3. In the provider, schedule `login-list.mjs` every minute from two or more regions, with `SYNTHETIC_BASE_URL`, `SYNTHETIC_ACCOUNT_EMAIL`, `SYNTHETIC_ACCOUNT_PASSWORD` and `SYNTHETIC_CHECK_TOKEN` in its secret store.

**Why the auth limiter needs to know about it.** NFR-2.6 allows 5 sign-in attempts per 15 minutes per address. A checker signing in once a minute makes 15, so it would lock itself out within five minutes and page someone about an outage that isn't happening. The limiter lets a request through uncounted only when **all** of these are true: it's `/login`, from an allowlisted address, carrying the token, and signing in as the synthetic account. A leaked token is useless from anywhere else. From an allowlisted address, it can only hammer the monitoring account, which FR-1.10's per-account lockout still protects. The integration test covers each missing condition and shows the request gets counted.

**Quota.** The round trip never analyses, so it consumes no analysis quota by construction. A test checks that the counters stay at zero after a round trip. There's nothing to exclude.

**A consequence to decide on.** Every successful login writes a `LOGIN_SUCCEEDED` audit row, and audit rows are kept for 13 months (§5.6). Two regions checking once a minute add about 2,900 rows a day, roughly 1.1 million over the retention window, all for the monitoring account. That's harmless to correctness, but it's volume. The options are to accept it, or to exempt the synthetic account from success auditing, which leaves a hole in the audit trail for one account. This is left as it is until the owner decides.
