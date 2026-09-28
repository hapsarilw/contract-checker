# Runbooks

One file per incident an operator may have to handle (SRS §12.3). Each opens with **what you are seeing**, because that is what you have when you arrive; the cause is what you are trying to find.

| Runbook | Reached from |
|---|---|
| [fabricated-excerpt-reported](fabricated-excerpt-reported.md) | `unverified_excerpt_displayed` (Sev 1), `cross_user_access` (Sev 1), or a user report |
| [provider-outage](provider-outage.md) | `circuit_open`, `llm_config_error` (Sev 2) |
| [analysis-failure-rate-high](analysis-failure-rate-high.md) | `analysis_failure_rate`, `api_5xx_rate` (Sev 2) |
| [database-restore](database-restore.md) | `readiness_failing`, `backup_verify_failed` (Sev 2), or data loss |
| [db-pool-saturated](db-pool-saturated.md) | `db_pool_saturated` (Sev 2) |
| [spend-ceiling-approaching](spend-ceiling-approaching.md) | `spend_ceiling_80` (Sev 3), `spend_ceiling_100` (Sev 2) |
| [stuck-pending-analyses](stuck-pending-analyses.md) | `stale_pending_analyses` (Sev 3) |
| [stale-scheduled-job](stale-scheduled-job.md) | `retention_job_stale` (Sev 3) |
| [analysis-latency-p95](analysis-latency-p95.md) | `analysis_latency_p95` (Sev 3) |
| [memory-high](memory-high.md) | `memory_high` (Sev 3) |
| [email-delivery-failures](email-delivery-failures.md) | `email_delivery_failures` (Sev 3) |
| [discard-rate-high](discard-rate-high.md) | `discard_rate_high` (Sev 3) |
| [risk-drift-high](risk-drift-high.md) | `risk_drift_high` (Sev 3) |
| [dependency-critical-vuln](dependency-critical-vuln.md) | `dependency_critical_vuln` (Sev 3) |
| [secret-rotation](secret-rotation.md) | scheduled rotation, or a suspected exposure (Sev 1) |
| [dsar-request](dsar-request.md) | a data subject request (§12.4) |

## Before you start any of them

**Where things are.** The API's metrics are on the dashboards (`ops/dashboards/`) and at `GET /metrics` with the bearer token (`ops/README.md`). Logs are JSON, one line per event, in the platform's log drain; the searches below use their `msg` and `alert` fields. Database and Redis are reached through the platform's own shell. Operator actions go through `npm run ops -- <command>` from a shell on the platform, in the `server` directory — there is no admin API, by design (`server/src/services/operator.js`).

**Three rules that apply in every one of them.**

1. **Read before you write.** Every query in these files is read-only unless the step says otherwise in bold. No `UPDATE` or `DELETE` by hand against production: the operator actions exist so that nobody has to.
2. **Secrets stay where they are.** When a step needs a token or a key, it comes from the platform's secret store into your shell for that command. It is never pasted into a ticket, a chat, a runbook or a commit, and production keys are never the development ones.
3. **Write it down as you go.** The time you arrived, what you saw, what you ran, what changed. The incident record is written during the incident, not reconstructed after it.

**Walkthrough status.** SRS §12.3: "A runbook that has never been followed is a draft." Each file ends with its walkthrough log. As of 2026-09-28 every one has been walked through on an **isolated local rehearsal stack** — its own Postgres, Redis and API process, nothing shared with anyone's development environment — and **none has been walked through in staging, because staging does not exist yet** (BUILD-PLAN step 71). The local walkthroughs found real defects, each recorded in the file where it applies:

- the process wedged with a small database pool — fixed: `DATABASE_POOL_SIZE` below 5 now refuses to boot ([db-pool-saturated](db-pool-saturated.md));
- `retention_job_stale` would never have stopped firing for the weekly and monthly jobs — fixed ([stale-scheduled-job](stale-scheduled-job.md));
- after a restore there was no way to find the accounts that came back, and the tool written for it first answered wrongly in a non-UTC zone — both fixed ([database-restore](database-restore.md));
- there was no operator path for DSAR erasure or for suspending an account — written ([dsar-request](dsar-request.md), [spend-ceiling-approaching](spend-ceiling-approaching.md));
- analyze attempts refused by an open circuit breaker still consume the user's monthly quota — **not changed: a product decision**, recorded in [provider-outage](provider-outage.md).

The staging walkthrough is still owed for all sixteen.
