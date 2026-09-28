# stuck-pending-analyses

**Severity 3, digest.** Reached from `stale_pending_analyses` (more than five analyses have been PENDING for over five minutes).

## What you are seeing

Users whose check "never finished": they left the analyzing screen, or it errored, and trying again on the same document answered **409 `ANALYSIS_IN_PROGRESS`** ("This contract is already being checked"). That lasts until the reaper marks the stuck row failed.

An analysis is PENDING only while a request is running it. One that stays PENDING past five minutes (FR-3.8) belongs to a request that died without recording an outcome — a crashed process, a restart mid-analysis, an instance killed for memory. The reaper finds those every minute and marks them `FAILED` with `errorCode = STALE_ANALYSIS`.

**Reading the gauge.** `stale_pending_analyses` is counted at the **start** of each reaper tick, before that tick's sweep. So after a tick that cleared six stuck rows, the gauge still says 6 until the next tick a minute later. A single reading of 6 is "six were found and swept", not "six are stuck".

## First five minutes

**1. Are they still stuck, or already swept?** (read-only)

```sql
select count(*), min("createdAt")
  from "Analysis"
  where status = 'PENDING' and "createdAt" < now() - interval '5 minutes';
```

- **0**: the reaper already cleared them. The question is no longer "why are they stuck" but "why did that many analyses die at once" — go to Diagnose, B.
- **More than 0 and growing**: the reaper is not running, or cannot reach the database. Go to Diagnose, A.

**2. Is the reaper running?** It logs every tick, once a minute, on whichever instance wins the lock:

```
"job":"reaper","msg":"reaper tick started"
"job":"reaper","staleCountAtStart":6,"lockAcquired":true,"reaped":6,"msg":"reaper tick finished"
```

Search the log drain for `"msg":"reaper tick finished"` in the last few minutes. The reaper has no last-success metric (it does not write to `JobRun`), so the log is how you know.

## Diagnose

**A. The reaper is not finishing ticks.**

- `"reaper tick started"` with no `"finished"` after it: a tick is hung waiting for the database. Check `/api/ready`, then [db-pool-saturated](db-pool-saturated.md) — a pool with every connection held wedges the reaper exactly this way.
- `"msg":"scheduled job tick failed"` with `"job":"reaper"`: the tick threw. The `err` field says why; a database-connectivity error means the fix is the database, not the reaper.
- No reaper log lines at all: no instance is running. That is a platform outage, not this runbook.

**B. The reaper is fine; analyses are dying.** When did they start, and did anything happen then?

```sql
select date_trunc('minute', "createdAt") as started, count(*)
  from "Analysis"
  where "errorCode" = 'STALE_ANALYSIS' and "createdAt" > now() - interval '6 hours'
  group by 1 order by 1;
```

A burst at one minute is one event: a deploy (rolling restarts drain for 90 s, and an analysis started just before can outlive it — a known, accepted edge in `services/analysis.js`), an instance restart, an out-of-memory kill ([memory-high](memory-high.md)). Check the platform's deploy and restart history for that minute.

A steady trickle over hours is different: analyses dying individually, which points at something per-request — the platform's proxy timeout cutting requests before the 90 s analyze ceiling (FR-3.7 requires it to be longer; check it is).

## Act

Usually nothing to repair: the reaper clears the rows, and the user can check the document again. Fix whatever killed the requests. If a deploy caused it, it is a one-off; if it is recurring, it is a platform-configuration problem.

Do **not** mark PENDING rows failed by hand. The reaper takes an advisory lock so two instances never do it at once, and a hand-written UPDATE racing a live analysis could fail an analysis that was about to complete.

## Close

Record: how many, over what window, whether the reaper was running, and what killed the requests.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | Six PENDING rows planted ten minutes old, as crashed requests would leave them; the read-only query in step 1; the reaper's log lines; the rows after the next tick; the gauge. | The query found 6. The next tick logged `staleCountAtStart: 6, reaped: 6`; the rows became `FAILED` / `STALE_ANALYSIS`. The gauge then read **6** although nothing was stuck any more — the one-tick lag described above, found here and now written into the symptom. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71).
