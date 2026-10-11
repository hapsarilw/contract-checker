# Alert drills

The record PRD §9's Phase 1.5 definition of done asks for: every alert in SRS Appendix C deliberately fired at least once and observed to arrive (BUILD-PLAN step 68). Drilled 2026-09-28 against the repository as of this file's commit.

**Verdict: NOT COMPLETE.** All nineteen alerts fired deliberately and were observed arriving at the right destination, through a real Alertmanager running the committed configuration. But **none of it happened in staging, because there is no staging** (Phase 1 DoD item 1 is still outstanding; BUILD-PLAN step 71 builds it), and **no paging provider has been chosen**, so the last hop — a real pager waking a real person — is untested. What is proven is the part that lives in this repository. What is owed is the part that needs an environment and an account.

| Part | Status |
|---|---|
| Every alert defined as code, with severity, destination, owner and runbook | **Done** |
| Every alert's rule tested — fires when it should, and does not when it shouldn't | **Done**: 18 rules, 49 promtool cases, 58 assertions |
| Every alert observed arriving at its destination | **Done**, against a real Alertmanager on this machine |
| One incident produces one notification, not a storm | **Was wrong; corrected in step 75.** Drilled here by posting the alerts all at once, which is not how an outage delivers them. End to end, a five-minute provider outage paged twice. Fixed and drilled again end to end: [phase-1.5-dod.md](phase-1.5-dod.md) §3 |
| The two structurally-impossible alerts forced and observed | **Done**, end to end through real HTTP requests |
| Any of the above repeated **in staging** | **Not done**: there is no staging |
| A real pager waking a real person | **Not done**: no paging provider chosen |
| `dependency_critical_vuln` fired from a real scan | **Not done**: the scanner is written (step 70) but has never run on GitHub, and a failed run is not yet wired to the digest |

---

## 1. What was drilled, and with what

| Tool | Version | What it proves |
|---|---|---|
| `promtool test rules` (Prometheus) | 3.7.3 | Each rule's PromQL, threshold, `for:` duration and labels, against synthetic series on a synthetic clock. Run with `cd server && npm run test:alerts`. |
| Alertmanager | 0.28.1 | Routing, grouping, inhibition and delivery. A real container running the committed `ops/alerts/alertmanager.yml`, delivering real webhooks to a receiver that records them (`server/tests/integration/alertRouting.test.js`). |
| The application itself | — | The two Sev-1 detections, through real requests against the real app and database (`server/tests/integration/alertDrills.test.js`). |

The Alertmanager drill runs the **committed** configuration with exactly two substitutions: the webhook URLs (which have to point at the test) and the group timings (which would otherwise make the drill wait 30 seconds per scenario and a quarter of an hour for a digest). The first assertion in that file compares the two configurations with only those fields normalised out, so the routing and the suppressions under test are provably the ones that would deploy.

## 2. Every alert, and how it was fired

All nineteen were fired and observed arriving at the destination Appendix C names. Five of them (marked *) are suppressed whenever their cause is also firing, so they were fired in a batch of their own — a drill that never delivered them would be proving the inhibitions rather than the routing.

| Alert | Sev | Arrived at | Fired by |
|---|---|---|---|
| `unverified_excerpt_displayed` | 1 | page | A finding row written straight to the table with an excerpt that is not in its document, then read back through the ordinary report route. Also via the staging-only drill endpoint. |
| `cross_user_access` | 1 | page | A document loaded with no owner filter and asserted against another subject, via the staging-only drill endpoint. |
| `circuit_open` | 2 | page | `llm_circuit_state = 1` held for six minutes. |
| `llm_config_error` | 2 | page | A 401 counted into `llm_request_total`. |
| `analysis_failure_rate` * | 2 | page | Four analyses failing in five, and a third failing, over 15 minutes. |
| `api_5xx_rate` * | 2 | page | 3% and 4.8% of requests answered 5xx over 10 minutes. |
| `readiness_failing` | 2 | page | `dependency_up` 0 on every instance for two minutes, once for Postgres and once for Redis; one instance still up, and a one-minute blip, do not page. |
| `db_pool_saturated` * | 2 | page | `db_pool_waiting` above zero for six minutes. |
| `spend_ceiling_100` | 2 | page | Spend equal to, and over, the ceiling. |
| `backup_verify_failed` | 2 | page | The gauge at 1. |
| `spend_ceiling_80` * | 3 | digest | Spend at 80% of the ceiling. |
| `discard_rate_high` | 3 | digest | 12.5% and 20% of reported findings discarded over 7 days. |
| `risk_drift_high` | 3 | digest | 27% and 33% rule/model disagreement over 7 days. |
| `analysis_latency_p95` * | 3 | digest | Histogram buckets putting p95 just over, and well over, 45 s. |
| `retention_job_stale` | 3 | digest | A job that never succeeded, and one whose last success was 37 hours old. |
| `stale_pending_analyses` | 3 | digest | The gauge at 6. |
| `memory_high` | 3 | digest | RSS at 81% and 85% of the configured limit for eleven minutes. |
| `email_delivery_failures` | 3 | digest | 12.5% and 20% of sends failing over an hour. |
| `dependency_critical_vuln` | 3 | digest | Posted with the labels `ops/alerts/ci-alerts.yml` declares. Its real source, the CI scan (`.github/workflows/ci.yml`, `scan.yml`), is written but has never run on GitHub. |

Every threshold is pinned from **both** sides: a case just over the line that fires, and one at or just under it that does not. That is not decoration — the first run of these tests passed with the failure-rate threshold moved from 25% to 50%, because the firing case was 80% and the quiet one 25%, and nothing sat in between. Six thresholds had that gap and now have a case in the band.

## 3. One incident, one notification

PRD §9's DoD item 3: a simulated five-minute provider outage must produce **one** alert, not a pager storm. Such an outage sets off four rules at once — the breaker opens, analyses start failing, the 5xx rate climbs because analyze answers 503, and latency follows.

Drilled: all four fired together, and **one** notification was delivered, naming `circuit_open` and nothing else. The other three were suppressed entirely, so there was no second page and nothing to read past in the morning either.

**Correction, 2026-10-05 (step 75): this proved the configuration, not the outage.** Posting all four at once skipped the one thing an outage controls, which is when each alert starts firing. In a real outage they do not start together:

- `analysis_failure_rate` and `api_5xx_rate` fire within two minutes;
- `circuit_open` waits five, by Appendix C's own condition;
- Alertmanager inhibits only while the source is firing, so the two symptoms had paged long before their inhibitor existed.

The end-to-end drill (`ops/drills/provider-outage`) measured it on the committed configuration: **two pages, 25 seconds apart**, and `circuit_open` never fired in a five-minute outage. The fix is not a timing tweak. It is a change of ownership: `api_5xx_rate` no longer counts failed analyses, which `analysis_failure_rate` already pages on. What was measured after the fix is in [phase-1.5-dod.md](phase-1.5-dod.md) §3. The same caution applies to the three suppressions below, which are drilled by posting their alerts together too.

Three other suppressions are drilled the same way:

- `spend_ceiling_100` suppresses `spend_ceiling_80` — one page, not a page and a digest.
- `llm_config_error` suppresses the failure rate and the 5xx rate, for the same reason the breaker does.
- `readiness_failing` suppresses `db_pool_saturated` and the failure rate: a database nothing can reach explains a pool with everything waiting on it.

**No inhibition may ever target a Sev-1.** Both Sev-1s were fired alongside the noisiest scenario available and arrived regardless, and a test asserts that no suppression in the configuration names either of them.

## 4. Forcing the two impossible ones

`unverified_excerpt_displayed` and `cross_user_access` fire on conditions the pipeline structurally prevents, so they cannot be drilled without planting the condition. `server/src/routes/drills.js` does that, and is kept out of production by three independent layers — the strongest being that **a production process with `ALERT_DRILL_TOKEN` set refuses to boot at all**, so a mistake in the other two cannot expose it.

What each drill proves, stated so this record does not overclaim:

- **`unverified_excerpt_displayed` is a true end-to-end drill.** It writes a finding whose excerpt is not in its document, bypassing the analysis service exactly as a bad migration or a later feature would, then reads the report through the **ordinary** route. The assertion, the metric, the refusal and the log line are the production ones. The planted row is removed afterwards, including when the assertion throws — which is the expected outcome, so a 500 there means the drill worked.
- **`cross_user_access` drills the assertion, not the whole path.** The ownership query filters by owner inside the statement, so no request can make it return another user's row; there is nothing to plant. The drill loads a document without that filter — the shape of the bug the alert exists for — and passes it through the same assertion the ordinary path calls. What is exercised is the detection, the metric and the refusal. What is **not** exercised is a real query losing its filter, which no drill can simulate without shipping the bug. A unit test covers the wiring from the other side: with a stubbed query returning a foreign row, the ownership loader refuses it.

Both fail closed. Nothing is served when either fires — not the fabricated finding, and not the genuine findings beside it.

## 5. What is still owed

1. **Repeat all of section 2 in staging** once it exists (step 71). The rules and the routing are proven; what staging adds is that the real Prometheus scrapes the real `/metrics`, that the real Alertmanager has the rules loaded, and that the alerts survive the trip. **Step 71 found that, as first built, this could never have happened:** the drill routes' boot-time refusal was keyed on `NODE_ENV=production`, and staging runs in production mode. It is now keyed on `DEPLOY_ENV`, and staging (`DEPLOY_ENV=staging`) may set `ALERT_DRILL_TOKEN` ([deployment.md](deployment.md), §1).
2. **Choose a paging provider and a digest destination**, put their URLs in `ops/alerts/alertmanager.yml` in place of the placeholders, and fire one Sev-1 at it. Until a person has been woken by this, "page" is a label.
3. **Fire `dependency_critical_vuln` from a real scan**: `scan.yml` exists (step 70) but nothing has been pushed, so it has never run. Run it once by hand (`workflow_dispatch`), then decide how a failed run reaches the digest. Today the only route is GitHub's own failed-workflow email to the repository owner.
4. ~~Write the four missing runbooks~~ — **done at step 69** (2026-09-28): `docs/runbooks/` has one for every alert, the four Appendix C left blank and the `cross_user_access` adaptation included, each walked through on a local rehearsal stack. The step-69 walkthroughs also found that `retention_job_stale` applied one 36-hour threshold to jobs that run weekly and monthly, so it would never have stopped firing; the rule now gives each job its own cadence (`ops/alerts/tests/jobs.yml`).

## 6. Known weakness, recorded rather than papered over

**The ratio alerts have no minimum volume.** `analysis_failure_rate` is "more than 25% of analyses failing over 15 minutes", so two analyses of which one failed is 50% and pages. The same is true of `api_5xx_rate` and `email_delivery_failures`. On a quiet service that is a page for nothing, which is exactly what Appendix C's closing note warns trains an operator to ignore the pager.

This is Appendix C's condition as written, and it is implemented as written. Quietly weakening a Sev-2 would be worse than living with it. The right fix is a floor — "and at least N analyses in the window" — and the right time to choose N is when there is a week of real traffic to choose it from, not now. Recorded here and in `ops/README.md` so it is a decision waiting to be made rather than a surprise at 3am.

**Decided 2026-10-05 (step 75), by the owner, before there was traffic.** The two ratio alerts that page, `analysis_failure_rate` and `api_5xx_rate`, now also require **at least three failures in their window**. Three is provisional: revisit it after the closed beta's first week, as the smallest count that is not that week's ordinary noise. `email_delivery_failures` is a digest and keeps no floor. Promtool cases pin both sides: two failures stay silent whatever the ratio, and three page when the ratio does.
