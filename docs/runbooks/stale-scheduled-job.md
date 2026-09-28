# stale-scheduled-job

**Severity 3, digest.** Reached from `retention_job_stale`: a scheduled job has not succeeded within its own cadence. The alert's `job` label says which.

## What you are seeing

Nothing, from the user's side — which is the danger. These jobs keep promises nobody checks day to day:

| Job | Cadence | Alert fires after | What stops happening |
|---|---|---|---|
| `retention` | nightly | 36 h | Documents older than 90 days are no longer deleted. **PRD §12.4 publishes that 90-day promise**, so a stopped retention job is a compliance problem, not just housekeeping. |
| `backup-verify` | weekly | 8 days | Nobody is checking that backups exist. (A *failed* check pages separately as `backup_verify_failed`.) |
| `quota-reset` | monthly, on the 1st | 32 days | Users' stored monthly counts are not rolled. Quota enforcement itself is unaffected (it reads the period, not the stored count); the data export shows stale numbers. |

A value of 0 means "never succeeded", deliberately, so that a job that has never run reads as maximally stale.

## First five minutes

**When did it last succeed, and did it fail since?** (read-only)

```sql
select job, "lastSuccessAt", "lastFailureAt", "lastFailureReason"
  from "JobRun" order by job;
```

- **`lastFailureAt` newer than `lastSuccessAt`**: it is running and failing. The reason, or the logs, say why.
- **Neither recent**: it is not running at all.

## Diagnose

**Not running at all.** Every job ticks on every instance (hourly, or every 15 minutes for retention), and one instance wins an advisory lock and does the work. Search the logs:

- `"retention run started"` / `"retention run finished"`, `"quota reset started"` / `"quota reset finished"`, `"backup verification passed"` — the job's own start and finish.
- `"msg":"scheduled job tick failed"` with the `job` field — the tick threw; `err` says why.

No lines for the job at all means no instance is running its schedule. A start with no finish means it hung — usually on the database; see [db-pool-saturated](db-pool-saturated.md), case A.

**Running and failing.** The error in `"scheduled job tick failed"`. For `backup-verify`, `lastFailureReason` is one of the reasons in [database-restore](database-restore.md), "The backup check failed".

**`backup-verify` stale in development:** it is only scheduled when `BACKUP_DIR` is set or in production, so in development it reads 0 — never succeeded — and this alert would fire for it. Development has no alerting, so it is noise only if someone points alerting at a development instance.

## Act

Fix the cause. Then restart an instance: every job ticks once at boot, and runs if it is due, so the next success is minutes away rather than a day. Confirm with the `JobRun` query.

**Retention specifically:** once it runs again it catches up in batches of 500 rows, all the way to done. If it was stopped for long, the first run may take a while; that is expected. If documents past 90 days were kept because of the outage, that is worth a line in the incident record, since it is the published promise that slipped.

## Close

Record: the job, how long it was stale, why, and — for retention — whether any document outlived its 90 days.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | The `JobRun` query and the `retention_job_last_success_timestamp` gauge on a running instance. | `retention` and `quota-reset` both showed a success at boot; `backup-verify` read **0** (not scheduled in development, no `BACKUP_DIR`). **Found a real defect in the alert rule:** it applied Appendix C's 36 hours to every job sharing the metric, so it would have fired for the monthly quota-reset from 36 hours into every month until the next, and for the weekly backup-verify on five and a half days of every week — a digest that never stops. The rule now gives each job its own cadence (the table above), and `ops/alerts/tests/jobs.yml` pins each threshold from both sides. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71).
