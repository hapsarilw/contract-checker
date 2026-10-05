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

## Alerts

`alerts/alerts.yml` is SRS Appendix C's catalogue as Prometheus alerting rules (eighteen of the nineteen; `dependency_critical_vuln` comes from the CI scanner and is declared in `alerts/ci-alerts.yml` in the same shape). `alerts/alertmanager.yml` is where they go and how they are grouped.

Load the rules into the Prometheus that scrapes `/metrics`:

```yaml
rule_files:
  - /etc/prometheus/alerts.yml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]
```

**Two destinations, and they must stay distinct.** `route: page` wakes someone; `route: digest` does not. Appendix C decides which is which, and a test asserts that every Sev-1 and Sev-2 pages and every Sev-3 digests, so a rule cannot be promoted by editing a dashboard. The receiver URLs in the committed file are placeholders: no paging provider has been chosen.

**Grouping and inhibition are what make an incident one notification.** A provider outage fires four rules at once; the inhibitions in `alertmanager.yml` suppress the three symptoms so the breaker is the only thing that pages. `docs/alert-drills.md` records that drill and the rest.

Testing:

```bash
cd server && npm run test:alerts     # promtool, every rule's expression and threshold
cd server && npx vitest run --project integration tests/integration/alertRouting.test.js
```

The first needs Docker (promtool comes from the Prometheus image); the second runs a real Alertmanager against the committed config and watches the webhooks arrive.

**An open decision, for when there is traffic.** The ratio alerts have no minimum volume, so two analyses of which one failed is a 50% failure rate and pages. That is Appendix C's condition as written and it is implemented as written; the fix is a floor, and the number for it should come from a week of real traffic rather than a guess. See `docs/alert-drills.md` §6.

**Every alert's runbook is in `docs/runbooks/`**, including the four Appendix C left blank (`db_pool_saturated`, `analysis_latency_p95`, `memory_high`, `email_delivery_failures`) and the `cross_user_access` adaptation. A test checks that every alert's `runbook_url` resolves.

## Synthetic uptime checks

§6.6 asks for checks against `/api/health` and a full login → list round trip, **from at least two regions, every minute.** `synthetics/login-list.mjs` is that check. It has no dependencies and exits non-zero on failure, so any provider that runs a Node script can use it (Checkly, Grafana Synthetic Monitoring, or a scheduler of your own). An integration test runs it against the real app.

**Set-up:**

1. Create the monitoring account in the app: register it and verify its email. Nothing else is needed; it never analyses anything.
2. On the API, set all three: `SYNTHETIC_ACCOUNT_EMAIL` (that account), `SYNTHETIC_CHECK_TOKEN` (≥ 32 random bytes) and `SYNTHETIC_CHECK_IPS` (the provider's published checker addresses, comma-separated, CIDR allowed). The server refuses to boot with only some of them set.
3. In the provider, schedule `login-list.mjs` every minute from two or more regions, with `SYNTHETIC_BASE_URL`, `SYNTHETIC_ACCOUNT_EMAIL`, `SYNTHETIC_ACCOUNT_PASSWORD` and `SYNTHETIC_CHECK_TOKEN` in its secret store.

**Why the auth limiter needs to know about it.** NFR-2.6 allows 5 sign-in attempts per 15 minutes per address. A checker signing in once a minute makes 15, so it would lock itself out within five minutes and page someone about an outage that isn't happening. The limiter lets a request through uncounted only when **all** of these are true: it's `/login`, from an allowlisted address, carrying the token, and signing in as the synthetic account. A leaked token is useless from anywhere else. From an allowlisted address, it can only hammer the monitoring account, which FR-1.10's per-account lockout still protects. The integration test covers each missing condition and shows the request gets counted.

**Quota.** The round trip never analyses, so it consumes no analysis quota by construction. A test checks that the counters stay at zero after a round trip. There's nothing to exclude.

**A consequence to decide on.** Every successful login writes a `LOGIN_SUCCEEDED` audit row, and audit rows are kept for 13 months (§5.6). Two regions checking once a minute add about 2,900 rows a day, roughly 1.1 million over the retention window, all for the monitoring account. That's harmless to correctness, but it's volume. The options are to accept it, or to exempt the synthetic account from success auditing, which leaves a hole in the audit trail for one account. This is left as it is until the owner decides.

## Load, soak and end-to-end (step 73)

`ops/load/load.mjs` runs SRS §10.6's TR-21 (20 analyses in flight for 10 minutes), TR-22 (a 2-hour soak) and TR-23 (50 simultaneous 5 MB uploads). `ops/load/run-local.sh` runs all three, plus TR-24 (`client/e2e/journey.spec.js`), against the local rehearsal stack. Results, dated, with configuration, and what they do and do not prove: [docs/load-test-results.md](../docs/load-test-results.md).

**Accounts.** A run needs many accounts, because NFR-2.6 allows 10 analyses per user per hour and those limits stay on during a load test. `npm run ops -- load-accounts --run R --count N --out FILE` creates them, together with sessions minted with the environment's own `JWT_SECRET`, so the secret never leaves the environment. `npm run ops -- load-cleanup --run R` removes them and everything they made. Both commands are refused when `DEPLOY_ENV=production`.

**Against staging** (on demand, never on every pull request), three things differ from the local run:

- **Per-address limits.** NFR-2.6 allows 100 requests per 15 minutes per address. The rehearsal's nginx lets each account present its own address (`X-Load-Client-IP`); a platform proxy honours no such header. From staging, run the generator from several machines, or accept the limiter's 429s as part of the result. Do not turn the limits off: they are part of what is under test.
- **Sampling.** The Docker sampler reads each container directly, and staging has no Docker to ask. Use the metrics backend instead:
  - `max by (instance) (process_resident_memory_bytes) / max by (instance) (memory_limit_bytes)` must stay ≤ 0.8;
  - `max(db_pool_waiting)` must stay 0;
  - `sum(db_pool_in_use)` is for context;
  - Postgres's own connection count comes from the provider's dashboard.
- **Swap.** Check that the platform gives the service no swap. If it does, "did not OOM" proves nothing (docs/load-test-results.md explains how this was found).

## Error tracking (step 74)

Sentry, through `server/src/observability/errorTracker.js`, and off unless `SENTRY_DSN` is set. **It is built so that a document's text cannot reach it**, because PRD §14.3 treats that as a Severity 1. There are four layers, and any one of them would be enough on its own:

1. **No automatic collection.** Sentry's default integrations are off, including the HTTP and AI instrumentations that record bodies and prompts. So is its own OpenTelemetry setup and its load-time patching of modules.
2. **`dataCollection` collects nothing**, set field by field: bodies, headers, cookies, query strings, user info, database query data, AI inputs and outputs, and the values of local variables in stack frames.
3. **`beforeSend` cleans every event again**: request data, extra data, user data, frame variables and breadcrumb contents are removed.
4. **On `/api/v1/documents*` and `/api/v1/account*`, the exception message is withheld too.** A Prisma validation error, for one, prints the data it rejected, and a Document's data is its text. The type and the stack trace are kept.

Only 5xx errors are reported; a 4xx is the client's business. Each report carries the method, the route pattern and the request id, nothing else about the request.

**For the owner: SRS §6.5 is out of date.** It specifies `sendDefaultPii: false`. Sentry 11 removed that option. Its replacement, `dataCollection`, **collects everything by default**, including HTTP bodies in both directions and the values of local variables. Someone following the SRS literally on the current SDK would remove the option to make the type check pass, and in doing so turn on all of that collection. The SRS should say "collect nothing" in the current SDK's terms.

**The proof** is `server/tests/integration/errorTracking.test.js`. It runs the real SDK, initialised the way the server does, against a recording transport, and fails an upload with a 500 whose message quotes the document. It then requires that the document's text, the query string and the session cookie appear **nowhere** in what would have been sent.

**Before pointing it at production**, choose the Sentry data region (US or EU) and add it to the subprocessor list (`client/src/legal/content.js`). Set the DSN in each environment's secret store; the rotation schedule is in [docs/runbooks/secret-rotation.md](../docs/runbooks/secret-rotation.md).
