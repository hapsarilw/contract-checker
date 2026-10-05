# provider-outage

**Severity 2, page.** Reached from `circuit_open` (the breaker has been tripped five minutes) or `llm_config_error` (the provider rejected a call with a non-retryable 4xx), and from [analysis-failure-rate-high](analysis-failure-rate-high.md) when `LLM_UNAVAILABLE` is the failing code, which is how a provider outage usually arrives first.

## What you are seeing

Users cannot run a check; everything else works. Analyze answers **503 `LLM_UNAVAILABLE`** ("The analysis service is temporarily unavailable…"), history, reports, login and deletion answer normally, and after a user's first failed attempt the upload screen shows the degraded-mode banner ("Analysis is temporarily unavailable — your saved reports are still here") with the check button disabled.

Two alerts lead here, and they mean different things:

| Alert | Means | Who fixes it |
|---|---|---|
| `circuit_open` | The provider is failing — 20+ calls in the window, half or more failing — so the breaker stopped calling it for 60 s at a time (FR-3.12). | Usually the provider. You confirm, communicate and wait. |
| `llm_config_error` | The provider refused us with a 400, 401, 403 or 404 (FR-3.11): a revoked or wrong API key, or a model identifier that no longer exists. Not retried, because retrying cannot help. | **You.** Nothing will recover on its own. |

**How a provider outage pages**, as measured by the step-75 drill ([phase-1.5-dod.md](../phase-1.5-dod.md), item 3), not as designed on paper: `analysis_failure_rate` pages first, about two minutes in, with `LLM_UNAVAILABLE` as the error code. That is the one page. If the breaker stays tripped for five minutes, `circuit_open` arrives in the **same** notification as an update (same route and domain, so the same group, the same incident at the paging provider), and from then on it suppresses `analysis_failure_rate`. `api_5xx_rate` does not count failed analyses, so the platform alert stays quiet. The earlier claim here, that `circuit_open` would suppress the others and be the only page, was wrong: inhibition starts only once its source fires, and `circuit_open` waits five minutes. The drill paged twice before the rules were changed.

## First five minutes

1. **Which alert?** If it is `llm_config_error`, go straight to "Act: configuration" below.
2. **Confirm with the provider.** Check the provider's status page. If it shows an incident, you have your cause.
3. **Verify the breaker is open, and until when.** On the dashboard: the "Circuit breaker" panel. From a shell with Redis access:
   ```bash
   redis-cli GET llm:cb:open_until          # epoch ms; empty = closed; in the past = half-open, one trial pending
   redis-cli LRANGE llm:cb:window 0 19       # "<epoch ms>:ok" / "<epoch ms>:fail", newest first
   ```
4. **Confirm degraded mode is what users see.** Upload screen in a normal browser: submit once, see the error card, go back — the banner must be there and the button disabled. Then check that a saved report still opens.

## Diagnose

What the provider answered, attempt by attempt (every retry counts):

```promql
sum by (outcome, http_status) (rate(llm_request_total[5m]))
```

- `429` / `529`: rate limited or overloaded — a provider incident, or our own traffic hitting our account's limit. The provider console says which.
- `5xx`: a provider incident.
- `timeout`: calls running past 60 s (`LLM_TIMEOUT_MS`). Either provider slowness, or a model change that made responses longer.
- `network`: no answer at all — DNS, egress, TLS. Check it is not us: can the instance reach the provider's API host at all?
- `400/401/403/404`: this is `llm_config_error`, below.

## Act

**Provider incident:** wait. The breaker re-tests on its own — once 60 s have passed since it opened, exactly one request is let through as a trial, and a success closes it. Do not force-close it while the provider is still failing; every request would then wait up to 60 s for a timeout, which is the connection pile-up the breaker exists to prevent.

**Provider recovered but the breaker is still open**, and you have confirmed with a real call that the provider answers: deleting the key closes it at once.

```bash
redis-cli DEL llm:cb:open_until
```

**Should the breaker window be longer?** Its numbers — 20 calls minimum, 50% failure, 60 s open — are constants in `server/src/services/llm/circuitBreaker.js`, not configuration, deliberately: changing them is a code change with a review, not a dial to turn in the middle of an incident. Raise it afterwards if the incident showed the breaker flapping open and shut every minute through a long outage.

**Configuration (`llm_config_error`):**

- `401` / `403`: the API key. Rotate it — see [secret-rotation](secret-rotation.md), "ANTHROPIC_API_KEY".
- `404`: the model identifier. `ANTHROPIC_MODEL` names a model the provider no longer serves. Changing it is a change to what the product says (PRD §11.1 makes the benchmark the gate for a model switch); do not guess a replacement in the middle of an incident — pause analysis with `ANALYSIS_ENABLED=false` instead, and choose with the benchmark.
- `400`: a parameter the model rejects. `server/src/config.js`'s model profile says which parameters each model takes; a model released since the last deploy may need its own entry.

## Communicate

On the status page (none chosen yet — PRD §14 names one as a launch requirement): "Checking new contracts is temporarily unavailable because of a problem with our analysis provider. Your saved reports and history are unaffected." Update when it recovers.

**Tell affected users about their quota.** Every analyze attempt that ended in `LLM_UNAVAILABLE` counted against the user's monthly allowance and hourly limit, even though no provider call was made (FR-5.2 counts every terminal outcome). The walkthrough measured it: one user, one successful check and three breaker refusals, `monthlyAnalyses = 4`. There is no operator tool to give it back. This is recorded as an open decision; until it is made, say so if a user asks why their allowance dropped.

## Close

Record: the alert, the provider's incident reference if any, when the breaker opened and closed, how many analyses failed (`analysis_total{outcome="failed",error_code="LLM_UNAVAILABLE"}`), and whether the breaker numbers need revisiting.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | Breaker forced open by setting `llm:cb:open_until`; three analyze attempts; the Redis reads in step 3; the metrics in Diagnose; reads checked during the outage; `DEL llm:cb:open_until`. | Analyze answered 503 `LLM_UNAVAILABLE` without calling the provider (`llm_request_total` unchanged); `llm_circuit_state` read 1; `analysis_total{outcome="failed",error_code="LLM_UNAVAILABLE"}` counted 3; history answered 200 throughout. **Found:** each refused attempt consumed the user's monthly quota (1 success + 3 refusals = 4) — recorded above and as an open decision. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71). The provider-status and status-page steps need real accounts.
