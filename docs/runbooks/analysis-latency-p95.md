# analysis-latency-p95

**Severity 3, digest.** Reached from `analysis_latency_p95`: the 95th-percentile analysis duration has been over 45 seconds for 30 minutes.

## What you are seeing

Users waiting longer on the analyzing screen than its copy promises ("usually about 30 seconds"). Nothing is failing yet. But the analyze ceiling is 90 seconds (FR-3.10) and the provider timeout is 60 (FR-3.6), so a p95 that keeps rising turns into `LLM_TIMEOUT` failures — [analysis-failure-rate-high](analysis-failure-rate-high.md) — and PRD §14.1's SLO is p95 under 45 s over a week.

## First five minutes

**Which stage is slow?** This is the question tracing was built to answer (§6.6). Take a slow analysis's `requestId` from the logs (`"msg":"analysis finished"` with a large `durationMs`) and open its trace. The children of the `analysis` span are:

| Span | Slow means |
|---|---|
| `analysis.provider_call` | The provider. Almost always this one. `llm.attempts` > 1 means retries: transient errors being backed off. |
| `analysis.validate` | Two of them means a schema retry: the first answer was invalid, and the analysis made a second provider call. |
| `analysis.verify` | Excerpt matching. Milliseconds normally; slow only on a very long document. |
| `analysis.persist` | The database. See [db-pool-saturated](db-pool-saturated.md). |
| `analysis.prompt` | Building the request. Microseconds; never the cause. |

Without tracing, the same split from the database (read-only):

```sql
select "retryCount", count(*), round(avg("durationMs")) as avg_ms,
       round(avg("outputTokens")) as avg_output_tokens
  from "Analysis"
  where status = 'COMPLETED' and "createdAt" > now() - interval '1 hour'
  group by 1 order by 1;
```

## Diagnose

- **Provider slow, retries 0**: the provider is slow for everyone (check its status page) — or our requests got bigger. A rise in `avg_output_tokens` points at a prompt or model change that made answers longer.
- **Retries 1 on many analyses**: the schema retry. The model is returning invalid output often enough to double the time. That is also the early form of `LLM_INVALID_OUTPUT` failures; check the prompt version against the benchmark.
- **`llm.attempts` > 1**: transport retries — the provider answering 429 or 5xx intermittently. The breaker has not opened because it is under 50%.

Check what changed:

```bash
git log --since="14 days ago" --oneline -- server/src/prompts server/src/config.js
```

and whether `ANTHROPIC_MODEL` or `LLM_TIMEOUT_MS` changed in the platform's configuration.

## Act

- Provider-side slowness: nothing to do but watch it; if it becomes timeouts, it is a failure-rate incident.
- A prompt or model change made it slower: that is a product trade-off, measured by the benchmark, not an operational fix. Record it.
- Do **not** raise `LLM_TIMEOUT_MS` to make timeouts go away. It must stay below the 90 s analyze ceiling (config refuses otherwise), and above it the ceiling cuts the analysis off anyway.

## Close

Record: the slow stage, the cause, and whether the 45 s SLO is at risk for the week.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | The duration histogram on `/metrics` after real analyses (mock provider); the SQL above. | `analysis_duration_seconds_count{outcome="completed"}` 2 with a sum of 0.004 s — the mock answers instantly, so a slow analysis could not be produced; the queries and metric names were confirmed. Tracing was off (no collector configured); the span names are the ones `server/tests/integration/observability.test.js` asserts. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71). A meaningful walkthrough needs the real provider and a trace collector.
