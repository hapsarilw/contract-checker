# Migration policy

The rules in SRS §5.5 and §12.2 as an operational checklist. This document is
the procedure; the SRS is the authority. Where they disagree, the SRS wins.

## The rule that makes everything else work

**A deploy never requires a schema change and a code change to land
simultaneously.** Every schema change is expand-first, contract-later. This is
not tidiness — it is what makes rollback possible. If the new code and the new
schema must arrive together, rolling back the code leaves it running against a
schema it does not understand, and the rollback becomes an outage of its own.

## The four phases

Run them in this order, in **separate releases**. Phases 1 and 4 never share a
release.

### 1. Expand — additive only

New nullable columns, new tables, new indexes. Nothing renamed, nothing
dropped, nothing made stricter.

The test: **the currently-deployed application version must keep running
against the new schema, untouched.** If it wouldn't, this is not an expand
migration and it cannot ship alone.

### 2. Deploy tolerant code

Code that writes and reads the new shape while still tolerating the old one —
because during a rolling deploy both versions are live at the same time, and
because a rollback puts the old version back in front of the new schema.

### 3. Backfill

In bounded, resumable batches, with progress logged.

- Bounded: a single `UPDATE` over a large table holds locks and blocks writes.
- Resumable: a backfill that cannot restart from where it stopped turns any
  interruption into a from-scratch rerun.
- Logged: an unobservable backfill cannot be confirmed complete, and phase 4
  depends on knowing that it is.

### 4. Contract — in a later release

Drop the old column, once **no running version references it**. Not "once the
new code is deployed" — once nothing that could still be rolled back to needs
it.

## Hard rules

### Migrations are a discrete CI step. Never at application boot.

`npm run db:migrate:deploy` runs as its own CI step, before the application
deploy. It is never invoked from application code, a start script, or a
container entrypoint.

With two or more instances (SRS §2's second critical constraint), boot-time
migrations race: every instance starts, every instance tries to migrate, and
the outcome depends on which one wins. `server/src/index.js` carries a comment
saying exactly this, and there is no `migrate` in any npm script other than the
two below.

### Index creation on `Document` or `Analysis` uses `CREATE INDEX CONCURRENTLY`

A plain `CREATE INDEX` takes an `ACCESS EXCLUSIVE` lock and blocks writes to
the table until it completes. On a populated `Document` or `Analysis` table
that is a write outage.

**`CONCURRENTLY` cannot run inside a transaction, and Prisma wraps every
migration in one.** A migration using it must therefore disable that wrapper —
in Prisma this is a separate migration file containing only that statement,
applied with the transaction disabled. Do not discover this in production: a
`CREATE INDEX CONCURRENTLY` inside Prisma's default transaction fails with
`CREATE INDEX CONCURRENTLY cannot run inside a transaction block`.

The one existing exception is
`20260907092547_analysis_one_pending_per_document`, which creates the FR-3.8
partial unique index with a plain `CREATE INDEX`. That is safe **only** because
it runs against an empty table on the initial deploy. It is not a precedent.

### Every migration is reviewed for lock behaviour

Before merging, state in the pull request which locks the migration takes and
for how long. Operations that block writes on a populated table include:
adding a column with a volatile default, changing a column type, adding a
`NOT NULL` constraint to an existing column, and non-concurrent index
creation.

### A forward-only migration is called out explicitly

If a migration cannot be rolled back — a dropped column, a destructive type
change — say so in the pull request, in those words. The reviewer needs to
know that the usual "redeploy the previous image" recovery does not apply.

### Migrations are tested against restored production data

§12.2: a migration is tested against a staging database restored from a
production backup before it runs in production. A migration that is instant on
an empty staging table can lock a real one for minutes.

## Commands

| Script | What it does | Who runs it |
|---|---|---|
| `npm run db:migrate:dev` | Creates a new migration from schema changes and applies it locally. Interactive; may reset the local database. | A developer, locally. Never in CI or production. |
| `npm run db:migrate:deploy` | Applies pending migrations. Non-interactive, never destructive. | CI, as its own step before the application deploy. |
| `npm run db:studio` | Opens Prisma Studio against the configured database. | A developer, locally. |

`db:migrate:dev` is the only one that generates migrations. `db:migrate:deploy`
only applies what is already committed — it will never create or modify a
migration file, which is what makes it safe to run automatically.
