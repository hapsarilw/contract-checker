# db-pool-saturated

**Severity 2, page.** Reached from `db_pool_saturated`: `db_pool_waiting` has been above zero for five minutes on at least one instance.

## What you are seeing

Everything is slow, then everything times out. Pages that read from the database — history, reports, sign-in — take seconds, then fail. `/api/ready` may still answer 200 (its one query eventually gets a connection), which is what makes this confusing: the database is up, and the app cannot use it.

What the gauge means: every connection in that instance's pool (`DATABASE_POOL_SIZE`, default 10) is checked out, and queries are queueing for one. For five minutes.

## First five minutes

**1. One instance or all?**

```promql
db_pool_waiting
db_pool_in_use
```

by instance, on the operational dashboard's "Database pool" panel. One instance: that instance. All: the database, or load.

**2. What is holding the connections?** From the database's own side (read-only):

```sql
select state, count(*), max(now() - state_change) as longest
  from pg_stat_activity
  where datname = current_database() and pid <> pg_backend_pid()
  group by state;
```

and the long-running ones:

```sql
select pid, state, now() - xact_start as in_transaction, left(query, 80) as query
  from pg_stat_activity
  where datname = current_database() and xact_start is not null and pid <> pg_backend_pid()
  order by xact_start limit 20;
```

## Diagnose

Match what `pg_stat_activity` shows:

**A. Many connections `idle in transaction`, and the reaper's log shows `"reaper tick started"` with no `"finished"`.** The job-lock wedge. Every scheduled job holds one connection for its advisory-lock transaction and needs a *second* to do its work (`server/src/jobs/lock.js` runs the work outside the lock transaction on purpose, so a long job is not one long transaction). If the lock transactions take every connection in the pool, the work waits for a connection forever, the lock transactions never end, and the instance stops answering. The step-69 walkthrough reproduced it: with a pool of 1, the reaper's first tick at boot wedged the server for as long as it was watched (over two minutes), with `pg_stat_activity` showing the app's only connection `idle in transaction`. **Since then `DATABASE_POOL_SIZE` below 5 refuses to boot** (four jobs, all ticking at boot, plus one to make progress with). If you see this pattern anyway, the pool is larger than 5 but the jobs are still competing with a burst of requests for it:
   - Restart the instance. It releases every connection; the jobs retry at their next tick.
   - Then raise `DATABASE_POOL_SIZE`, within the capacity model below.

**B. Many connections `active`, each running the same slow query.** A slow query, not a small pool. The `query` column says which. A missing index shows up this way after a data change; so does a history page for an account with very many documents. Fix the query; a bigger pool only lets more copies of it run at once.

**C. Connections `active`, all short, just many.** Load. More requests than one instance's pool can serve. The scaling lever is instance count (SRS §6.1), not pool size, because the database's connection limit is shared by every instance.

**D. Nothing much in `pg_stat_activity`, but the app's pool is full.** The connections are held in the app, not in the database: a code path that checks one out and does not return it. Restart to recover; the trace and the logs for the same minutes say which route.

## Act

**The capacity rule, before you raise anything:** `instances × DATABASE_POOL_SIZE` must stay under the database's connection limit, with a margin (SRS §6.1):

```sql
show max_connections;
```

Raising the pool past that makes every instance fail to connect, which is worse than a queue.

- **Restart** the saturated instance: immediate relief for A and D, none for B and C.
- **Add an instance** for C, if the capacity rule allows.
- **Raise `DATABASE_POOL_SIZE`** for A, if the capacity rule allows. Never below 5.
- **Fix the query** for B.

## Communicate

If users are seeing errors: "ClauseCheck is slow or unavailable; we are working on it. Your data is safe."

## Close

Record: which instance(s), what `pg_stat_activity` showed, which case it was, what you changed, and whether the capacity model needs revisiting.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | The server started with `DATABASE_POOL_SIZE=1`, then twenty concurrent history reads; `pg_stat_activity` and the logs read while it was stuck; the same with pools of 3 and 4. | **Found a real defect: the instance wedged.** The reaper's boot tick held the only connection in `idle in transaction` and waited for a second (`pg_stat_activity`'s other row was the inspecting session itself — the queries above now exclude it); the reaper's later ticks logged "started" and never "finished"; the reads never completed. With pools of 3 and 4 the boot race did not happen in that run — which makes it a race, not a guarantee. `DATABASE_POOL_SIZE` now refuses anything below 5 at boot, and case A above describes the wedge for a larger pool under load. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71). The capacity numbers need the real database's `max_connections`.
