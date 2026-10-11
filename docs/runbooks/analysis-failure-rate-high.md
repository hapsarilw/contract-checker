# analysis-failure-rate-high

**Severity 2, page.** Reached from `analysis_failure_rate` (more than 25% of analyses failing over 15 minutes) or `api_5xx_rate` (more than 2% of requests answered 5xx over 10 minutes, failed analyses aside).

## What you are seeing

Users are getting error cards instead of reports. Some checks still complete; a quarter or more do not. Or, for `api_5xx_rate`, the server is answering a noticeable share of requests with a server error that is **not** a failed analysis: reads, sign-in, uploads, or the analyze route failing before an analysis was created. Failed analyses are subtracted from that alert because this one already pages on them, with the error code (step 75: counting them in both paged twice for one provider outage).

A provider outage usually arrives **here first**: `analysis_failure_rate` fires about two minutes in, and `circuit_open` needs five. If `LLM_UNAVAILABLE` is the dominant code below, go to [provider-outage](provider-outage.md). Once `circuit_open` fires, it suppresses this alert.

## First five minutes

**Which failure is it?** Everything in this runbook starts from one query:

```promql
sum by (error_code) (increase(analysis_total{outcome="failed"}[15m]))
```

## Diagnose: the decision tree

Read the largest `error_code` and follow its branch.

**1. Provider-shaped** — `LLM_UNAVAILABLE`, `LLM_TIMEOUT`
The provider is failing but not enough to open the breaker (fewer than 20 calls in the window, or under 50% failing). Check the provider's status page and `sum by (http_status) (rate(llm_request_total[5m]))`. If it is getting worse, this becomes [provider-outage](provider-outage.md). `LLM_TIMEOUT` alone with a healthy provider: a model or prompt change that made responses longer — see [analysis-latency-p95](analysis-latency-p95.md).

**2. Output-shaped** — `LLM_INVALID_OUTPUT`, `ALL_FINDINGS_DISCARDED`
The provider answered, and the answer was unusable: not valid against the schema twice in a row, or every finding's quote failed verification. This is almost always **ours**: a prompt change, a model change, or a schema change. Check what changed:
```bash
git log --since="14 days ago" --oneline -- server/src/prompts server/src/schemas server/src/config.js
```
and which prompt version and model the failures came from:
```sql
select "promptVersion", model, "errorCode", count(*)
  from "Analysis" where status = 'FAILED' and "createdAt" > now() - interval '1 hour'
  group by 1, 2, 3 order by 4 desc;
```
A spike of `ALL_FINDINGS_DISCARDED` is also [discard-rate-high](discard-rate-high.md) at its worst: read that one too.

**3. Our defect** — `INTERNAL`
A bug. The logs have it: search for `"msg":"request failed"` with `"err"` for the analyze route, and follow the `requestId` into the trace (`analysis.*` spans) if tracing is on. Correlate with the last deploy: `GET /api/version` gives the running commit.

**4. Document-shaped** — failures concentrated on a few documents or one user
```sql
select d."userId", d."sourceType", d."wordCount", a."errorCode", count(*)
  from "Analysis" a join "Document" d on d.id = a."documentId"
  where a.status = 'FAILED' and a."createdAt" > now() - interval '1 hour'
  group by 1, 2, 3, 4 order by 5 desc limit 20;
```
One user retrying one strange document can dominate a low-traffic hour. The alert needs at least three failures (`docs/alert-drills.md` §6), so three attempts at one bad document are enough to page. If that is all it is, it is not an incident: note it and look at the document shape (source type, word count) for a reproducible case.

**5. `STALE_ANALYSIS`** — analyses dying without reaching a terminal state. See [stuck-pending-analyses](stuck-pending-analyses.md).

**For `api_5xx_rate`:** find the route first.
```promql
sum by (route, status) (rate(http_request_duration_seconds_count{status=~"5.."}[10m]))
```
The alert has already subtracted failed analyses, so an analyze-route 5xx here failed **before** an analysis existed: `503 SERVER_BUSY` is the analysis limiter failing closed, which means Redis; `503 DATABASE_UNAVAILABLE` is the database (step 75); a `500` is branch 3. Anything else is branch 3, or the database: check `/api/ready` and [db-pool-saturated](db-pool-saturated.md).

## Act

**When to flip `ANALYSIS_ENABLED=false`:** when the failures are ours (branches 2 and 3) and every analysis that runs is spending provider tokens to produce an error. Set it in the platform environment and restart. Users then get an honest "paused" message instead of a failure after a thirty-second wait, no quota is consumed, and reads are untouched. Do **not** flip it for a provider-shaped failure: the breaker handles that, and a paused product stays paused after the provider recovers, until someone remembers.

**Roll back** if the failures started with a deploy: redeploy the previous image (SRS §8 — safe because the previous version runs against the current schema). Then confirm with `GET /api/version`.

## Communicate

Branches 2 and 3 on the status page: "Some contract checks are failing. We have paused checking while we fix it; your saved reports are unaffected." Branch 4 needs no public message.

## Close

Record: the dominant error code, the branch, the cause, whether analysis was paused and for how long, and the deploy or change responsible.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | Failures produced (breaker forced open), then read back by `error_code` from `/metrics`; the SQL in branches 2 and 4; `ANALYSIS_ENABLED=false` and restart, then back. | `analysis_total` separated `completed/none` from `failed/LLM_UNAVAILABLE` as the tree expects. The flag produced 503 `SPEND_LIMIT_REACHED` with the "paused" message, reads answered 200, and the user's quota did not move. Counters reset to zero on restart — the dashboards use `increase()`, which handles that; a raw read of `/metrics` after a restart does not show history. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71).
