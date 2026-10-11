# database-restore

**Severity 2.** Reached from `readiness_failing` (the database is unreachable from every instance), `backup_verify_failed` (the weekly check could not find a plausible backup), or a discovery that data has been lost or corrupted.

**The clock.** NFR-3.6: **RPO 24 h** (at most a day of data lost), **RTO 4 h** (service back within four hours of the decision to restore). Write the time down now, when you arrive; the RTO is measured from it.

## What you are seeing

One of three things, which lead to different sections:

- **Everything is down.** `/api/ready` answers 503 naming `postgres`; the app answers errors on every signed-in page. → "The database is unreachable" below.
- **Analysis is refused, everything else works.** The alert's `dependency` label is `redis`, and `/api/ready` names `redis`. This is FR-5.6's degraded mode, not a restore: reads and sign-in work unmetered, and checking a contract answers `SERVER_BUSY`. → "Redis is unreachable" below.
- **The backup check failed.** Nothing is broken yet. The last backup is missing, too old, too small, or shrank. → "The backup check failed".
- **Data is wrong or missing** — a bad migration, a mistaken bulk change, corruption. → "Restoring".

## The database is unreachable

Most of these are **not** restores. Rule those out first — restoring when the database was merely unreachable loses up to a day of data for nothing.

1. `GET /api/ready` — the body names which dependency failed.
2. The database provider's status page and console: is the instance up? Out of storage? Out of connections?
3. If the provider shows the instance healthy, check [db-pool-saturated](db-pool-saturated.md): a wedged pool looks like an unreachable database from outside.
4. Only if the instance is **gone or unrecoverable** do you restore.

## Redis is unreachable

Nothing is restored, and nothing is lost: Redis holds counters, the circuit breaker and idempotency keys, all of which expire or rebuild.

1. The Key Value instance's status in the platform console. Out of memory with `noeviction` refuses writes, which looks the same as down.
2. Wait for it, or restart it. Each API instance reconnects within a couple of seconds and its rate limiters initialise again on the next request (step 75); no API restart is needed.
3. Confirm: `/api/ready` 200, and a contract check succeeding.

## The backup check failed

`backup_verify_failed` pages because a backup nobody has verified is a hope. The reason is in the `JobRun` table:

```sql
select "lastSuccessAt", "lastFailureAt", "lastFailureReason" from "JobRun" where job = 'backup-verify';
```

| Reason | Means |
|---|---|
| `no_source_configured` | `BACKUP_DIR` is not set. In production this is the misconfiguration the job exists to catch. |
| `source_unreadable` | The directory exists in config but cannot be read. |
| `no_backups` | The directory is empty. |
| `too_old` | The newest backup is older than `BACKUP_MAX_AGE_HOURS` (36): backups have stopped. |
| `too_small` | The newest is under `BACKUP_MIN_BYTES`. |
| `shrunk` | The newest is under half the size of the one before it. |

Fix the backup source, then wait for the next check (it retries hourly after a failure) or restart an instance to run it at boot. The page clears when a check passes.

## Restoring

**Never restore over the damaged database.** Restore into a new one, verify it, then switch the app to it. The damaged one is evidence, and it is the thing you go back to if the restore turns out worse.

1. **Stop writes.** `ANALYSIS_ENABLED=false` and restart, so nothing new is written to the database you are about to leave. (Sign-ins and deletions still write; if the restore will take long, put the app in maintenance at the platform level.)
2. **Choose the backup.** The provider's point-in-time recovery if it has one — pick a moment just before the damage. Otherwise the newest backup that predates it.
3. **Restore into a new database.** With the provider's own restore, or from a `pg_dump` file:
   ```bash
   pg_restore -d "<new database url>" --no-owner --exit-on-error clausecheck.dump
   ```
4. **Verify before you switch.** Row counts against the old database if it is still readable; the schema against this build's migrations:
   ```bash
   cd server && DATABASE_URL="<new database url>" npx prisma migrate status
   ```
   "Database schema is up to date!" is what you want. A pending migration means the backup predates a schema change: run `npx prisma migrate deploy` against it before switching — SRS §5.5's expand/contract rule is what makes that safe.
   ```sql
   select (select count(*) from "User") users, (select count(*) from "Document") docs,
          (select count(*) from "Analysis") analyses, (select count(*) from "AuditEvent") audit;
   ```
5. **Before switching, re-erase every account that came back.** An account deleted after the backup was taken **is in the restore**, with every contract its owner deleted — which breaks the promise PRD §12.4 made them. Nothing in the restored database says which ones: the deletion events are in the OLD database, and they hold only a hash of the user id. So, while the old database is still readable:
   ```bash
   # the OLD database's URL, in a file only you can read — not on the command line
   umask 077; printf '%s' '<old database url>' > /tmp/old-db-url
   cd server && DATABASE_URL="<new database url>" npm run ops -- restore-deletions --since <the backup's time, ISO 8601> --old-database-url-file /tmp/old-db-url
   rm /tmp/old-db-url
   ```
   Run against the NEW database — the app is not pointed at it yet, so a resurrected contract is never served, not even for a minute. It lists every account in the restored database that was deleted in the old one after the backup. Erase each, deliberately:
   ```bash
   DATABASE_URL="<new database url>" npm run ops -- erase --email <address> --reference <incident id> --confirm <address>
   ```
   It needs the same `AUDIT_SALT` the old events were written with — see [secret-rotation](secret-rotation.md) for why that salt is never rotated casually.

   **If the old database is not readable at all**, the deletions since the backup cannot be reconstructed from this system. The one other record is the email provider's send log: every deletion sent a "Your ClauseCheck account has been deleted" message. Match those recipients against the restored accounts and erase them. State in the incident record how far that got.

6. **Switch.** Point `DATABASE_URL` at the new database in the platform's secret store, restart, and check `/api/ready` answers 200.
7. **Prove it serves.** Sign in as a test account, open history, open a report.
8. **Re-enable** analysis. **Stop the clock** and record the elapsed time against the 4-hour RTO.

**What is lost.** Everything written between the backup and the damage. Users who signed up in that window no longer exist; documents uploaded in it are gone.

## Communicate

On the status page from the start: "ClauseCheck is unavailable while we restore service. Your data is safe." After: say plainly what window of data was lost, if any.

## Close

Record: the time you arrived, the time you decided to restore, the backup used and its age (against the 24 h RPO), the elapsed time (against the 4 h RTO), the row counts compared, and the deletions re-run.

---

## The timed drill (`scripts/restore-drill.sh`)

The rehearsal NFR-3.6 asks for every 6 months, as one command. It takes a synthetic database at a production-like volume, backs it up with `pg_dump -Fc`, and then runs the RTO clock:
1. provision a new Postgres;
2. `pg_restore`;
3. verify every table's row count, plus a checksum of every document's text and every finding's excerpt against the original, plus Prisma's migration status;
4. start the API on the restored database and wait for `/api/ready` 200.

It prints each step's time. Removing a single row after the restore makes it fail (verified).

**The volume, and why.** The default is a pessimistic projection of year one:
- **5,000 accounts**;
- **20,000 documents** in the 90-day window (four per account), each **24 KB**, which is about the 4,000-word cap and so the worst case rather than the average;
- one analysis and **six findings** per document;
- **250,000 audit events** (13 months' retention).

The text is random hex, so Postgres cannot compress it the way it would compress a repeated phrase. Smaller runs: `DRILL_DOCS=2000 scripts/restore-drill.sh`.

**What the clock covers, and what it does not.** NFR-3.6's 4 hours run from the decision to restore to the service being back:

| Part of the RTO | Measured where | Time |
|---|---|---|
| Notice, and decide to restore | not measurable in a drill: the alert (`backup_verify_failed`, `api_5xx_rate`) plus a person | owed to the real incident |
| The provider's own restore or PITR into a new instance | **not measured: no provider chosen** | owed to staging |
| Provision, restore, verify, API up | **2026-10-05, locally: 18.6 s at 695 MB** | below |
| Point production at the new database and roll the instances | step 71's rolling restart: about 45 s for two instances | measured |

Even if the managed provider's restore takes a hundred times longer than a local `pg_restore`, the budget holds. The part to measure for real is the provider's, and only staging can measure it.

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | Step 8: a backup taken, then an account deleted through self-serve deletion, then the backup restored into a new database — the account was back. `restore-deletions` against it. | **Found:** there was no way to do step 8 at all — "re-run the deletions" named events that are not in the restore and hold only hashes — so `restore-deletions` was written. **Its first run reported "0 deleted" and was wrong:** it passed a local-time instant to a zoneless UTC column, which on a UTC+8 machine moved "since" eight hours ahead; a UTC server would never have shown it. Fixed, and the server's tests now run in a non-UTC zone so it cannot come back unseen. Second run: exactly the deleted account listed, the account that never left not listed; `erase` removed it. |
| 2026-09-28 | isolated local rehearsal stack (not staging) | Steps 3 to 6 against a real Postgres: `pg_dump -Fc` of the rehearsal database, a new Postgres, `pg_restore --no-owner --exit-on-error`, row counts on both sides, `prisma migrate status`, the app restarted against the restored database, a sign-in, history and a report read from it. | Restore exit 0; row counts identical on all five tables checked; "Database schema is up to date!"; `/api/ready` 200; the existing user signed in and read a completed report. **Elapsed 5 seconds — which says nothing about the 4-hour RTO:** the database was 21 KB. What this proves is the procedure, not the time. |

| 2026-10-05 | isolated local containers (not staging, not a managed provider) | `scripts/restore-drill.sh` at the projected year-one volume (above): 5,000 accounts, 20,000 documents, 120,000 findings, 250,000 audit events; synthetic database **695 MB**, dump **300 MB** (backup 16.6 s). | **RTO clock 18.6 s against 4 h**: provision 1.7 s, `pg_restore` 12.9 s, verify 2.4 s (every count and both checksums identical; "Database schema is up to date!"), API ready 1.4 s. The drill's own check was proven able to fail: one finding deleted after the restore, and it stopped with exit 1, the count 1200 → 1199 and the checksum changed. One defect in the drill found and fixed before this run: `UNION ALL` gives no order guarantee, so the two sides are now sorted before comparing. |

**Staging walkthrough: not yet done**, and this is the one that matters most. PRD §9's Phase 1.5 DoD item 2, as worded, asks for a restore from backup into a scratch database, timed against the RTO. The local drill above meets that ([phase-1.5-dod.md](../phase-1.5-dod.md) §2). But production's backups will be the managed provider's, and only a restore from one of those, at a production-like size, measures the part of the 4 hours that is still unknown. *(Corrected 2026-10-05: this said item 2 required the managed provider's backup; the PRD does not say that.)* That needs the hosting decision (none made) and staging (BUILD-PLAN step 71).
