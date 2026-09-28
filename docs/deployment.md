# Deployment, staging and rollback

BUILD-PLAN step 71 (OPS-8). SRS §2.3, §5.5 and §8, and PRD §15, are the authority; this document is the procedure. Where they disagree, the SRS wins.

**Status, 2026-09-29: NOT COMPLETE.** There is no staging, because no hosting platform has been chosen. Everything that does not depend on a platform is built and has been run for real. The deploy workflow's steps, the checks it runs, the drain, the timeout chain behind a real proxy, and a rollback to an older image against the current schema all passed in a local rehearsal (§7). What is owed is the platform, and then the same checks run against it. None of the four "done when" items in BUILD-PLAN step 71 can be ticked yet, because each says "in staging".

| Done when (BUILD-PLAN step 71) | Where it stands |
|---|---|
| Staging built from the production manifests, synthetic data only | **Not done: no staging.** The manifest rule is settled (§1): one image, one config schema, `DEPLOY_ENV` the only named difference. |
| Migrations run as a discrete step, never at boot | **Built and rehearsed.** `deploy.yml`'s `migrate-*` jobs; the image cannot migrate (no Prisma CLI in it); rehearsal scenario 1. |
| A real 50-second analysis completes through the staging proxy | **Rehearsed locally, not in staging.** Through nginx: cut at 30 s, completed at 150 s (§4). The staging run is `verify-staging`'s second step. |
| A rollback to the previous image is tested and works | **Rehearsed locally, not in staging.** The oldest image that predates the newest migration, on the current schema (§6). |

---

## 1. One image, two environments

Staging and production run **the same image** (built once per commit by `deploy.yml`'s `image` job, tagged with the full commit SHA) with **the same configuration schema** (`server/src/config.js`). Both run with `NODE_ENV=production`. SRS §2.3: "differing only in scale and secrets. A staging environment that drifts from production tests a system nobody runs."

What differs, and nothing else:

| | staging | production |
|---|---|---|
| `DEPLOY_ENV` | `staging` | `production` |
| Instances | 2 (fewer is not a smaller production: a rolling deploy needs two) | ≥ 2 (SRS §8) |
| Secrets: `JWT_SECRET`, `AUDIT_SALT`, `METRICS_TOKEN`, `DATABASE_URL`, `REDIS_URL`, `EMAIL_PROVIDER_KEY`, `SYNTHETIC_CHECK_TOKEN` | its own | its own |
| `ANTHROPIC_API_KEY` | **its own key**, with its own `MONTHLY_SPEND_CEILING_USD` | its own key |
| `FRONTEND_ORIGIN`, public URLs | staging's | production's |
| `ALERT_DRILL_TOKEN` | set, for the alert drills (step 68) | **refused at boot** |
| Data | **synthetic only** | real |

**`DEPLOY_ENV` is new in step 71, and it fixed a real contradiction.** Step 68's alert drills were written as "staging only", and production refused to boot with `ALERT_DRILL_TOKEN` set. But the refusal was keyed on `NODE_ENV=production`, and staging runs in production mode too, so the drills could never have run in the one place they were for. The refusal now reads "production mode and not `DEPLOY_ENV=staging`". A production-mode process that doesn't say which environment it is counts as production, and `DEPLOY_ENV` is itself required whenever `NODE_ENV=production`.

**Also new: the mock provider is refused in production mode, staging included.** Before this step, nothing stopped `NODE_ENV=production` with `LLM_PROVIDER=mock`. That combination serves every user a canned, well-formed analysis that no model wrote, and it raises no error anywhere. Staging falls under the same refusal because SRS §2.3 gives it a real key.

**Synthetic data only, in practice:**
- Staging's accounts are the smoke account and accounts created for a drill or a test. Nothing is imported.
- **A production backup is never restored into staging**, not for a restore rehearsal and not "just to reproduce a bug". The restore rehearsal ([runbooks/database-restore.md](runbooks/database-restore.md)) restores staging's own backup.
- Every check that creates a document deletes it afterwards (`checks.mjs long-analysis`, `e2e/staging.spec.js`).

## 2. The pipeline: `.github/workflows/deploy.yml`

It triggers when **CI succeeds on a push to `main`**. A pull request's CI run never triggers it, and neither does a fork's.

```
image  (build once, push ghcr.io/hapsarilw/clausecheck-server:<sha>)
  └─ migrate-staging      prisma migrate deploy, a discrete step
      └─ deploy-staging   platform.sh deploy-api staging <image>
          └─ frontend-staging   client built against staging's API, published
              └─ verify-staging  smoke · long analysis (timeout chain) · E2E + axe
                  └─ migrate-production   ← waits for the required reviewer
                      └─ deploy-production   rolling, then smoke
                          └─ frontend-production
                              └─ watch-production   15 minutes
```

- **Migrations are their own job** in each environment, before that environment's deploy, and never at boot (SRS §5.5: with two instances, boot-time migrations race). The API image can't migrate even by mistake: its runtime stage has no Prisma CLI.
- **The API goes out before the frontend.** A new client may call an endpoint that only the new API has, never the reverse, which is what lets each roll back on its own.
- **The approval gate is the `production` GitHub environment's required reviewer.** `migrate-production` is the first job that touches production, so it is the one that waits.
- **The smoke check** (`ops/deploy/checks.mjs smoke`) reads `/api/version` twelve times and requires **every** answer to be the new SHA. After a rolling deploy, one instance still on the old image is exactly what "done" must not leave behind. It then checks `/api/ready` and runs the synthetic check's own signed-in round trip.
- **The 15-minute watch** (`checks.mjs watch`) runs the smoke check every minute and tolerates one failed probe as a blip; a second fails the watch. With `PROMETHEUS_URL` set, it also reads `api_5xx_rate`'s own ratio and fails above that alert's 2%, so the watch fails no later than the pager would. A failed watch doesn't roll anything back by itself; rolling back is a person's decision (§6).
- **One deploy at a time, never cancelled half-way** (`concurrency`).

### GitHub setup the workflow needs (owner, once)

Settings → Environments → create **`staging`** and **`production`**. Give `production` a **required reviewer**. On this account tier that reviewer can be the person who merged; see [branch-protection.md](branch-protection.md) for the self-review rule that applies here too.

Per environment, **environment-scoped, never repository-wide**, so that staging's jobs cannot read production's values:

| Kind | Name | What |
|---|---|---|
| secret | `DATABASE_URL` | that environment's database, for the migration job only |
| secret | `PLATFORM_TOKEN` | the hosting platform's deploy token |
| secret | `SMOKE_ACCOUNT_PASSWORD` | the smoke account's password |
| secret | `SYNTHETIC_CHECK_TOKEN` | optional; only useful from an allowlisted address |
| secret | `PROMETHEUS_TOKEN` | optional |
| variable | `DEPLOY_PLATFORM`, `API_URL`, `FRONTEND_URL`, `SMOKE_ACCOUNT_EMAIL`, `PROMETHEUS_URL` | |

**The provider key is not in this list, on purpose.** `ANTHROPIC_API_KEY` lives in the hosting platform's secret store, per environment, and nowhere in GitHub. `server/tests/unit/ciPipeline.test.js` fails if `deploy.yml` reads any secret outside the list above, or reads one from a job without an `environment:`.

**The migration job connects to the database from a GitHub runner.** The chosen database must accept that (TLS, a strong password, and ideally an IP allowlist, though GitHub's runner addresses are broad). If it can't, the alternative is a one-off job on the platform that runs the same `npx prisma migrate deploy`. That still counts as a discrete step, provided it runs **before** the new instances start and never inside them.

## 3. The smoke account

Created **once per environment, through the real sign-up and email-verification flow**, with an address the owner controls. Its password goes into the environment's `SMOKE_ACCOUNT_PASSWORD` secret. It is also the account `e2e/staging.spec.js` signs in as, and the one `SYNTHETIC_ACCOUNT_EMAIL` names for the §6.6 synthetic check.

## 4. The timeout chain (FR-3.7)

| Link | Value | Where |
|---|---|---|
| Platform proxy / load balancer idle timeout | **must exceed 120 s**, and must be verified | the platform |
| Server request timeout | 120 s (keep-alive 121 s, headers 125 s) | `server/src/config.js` |
| Analyze ceiling | 90 s | `server/src/config.js` |
| LLM timeout | 60 s (`LLM_TIMEOUT_MS`, boot refuses ≥ 90 s) | `server/src/config.js` |
| Shutdown drain | 90 s | `server/src/config.js` |
| Platform stop grace period (SIGTERM → SIGKILL) | **must exceed 90 s** | the platform |

**How it is verified.** `node ops/deploy/checks.mjs long-analysis` signs in as the smoke account and pastes the longest document the product accepts: fixture 05's synthetic MSA cut to 3,919 words, under FR-2.6's 4,000-word cap. It runs a real analysis through the public URL, then deletes the document. Outcomes:

- **pass**: 200 after ≥ 50 s, so every layer let a request of that length through;
- **fail**: cut, or anything but 200. The elapsed time is the clue: a cut at a round 30 s or 60 s is a proxy default, not this application;
- **inconclusive** (exit 3): 200, but under 50 s, so the chain was never stretched.

`verify-staging` runs it on **every** deploy, not once, because a platform setting can change under a deploy that changed nothing. Inconclusive doesn't fail the deploy.

**If staging keeps coming back inconclusive**, the real provider is simply faster than 50 s on the longest permitted document. That's good news for users and no proof about the proxy. Record the platform's documented idle timeout for the service in the log below, with where it's documented, and keep the check running: the day an analysis does take 50 s, it will test the chain. **Don't switch staging to the mock provider to force a 50-second analysis.** Production mode refuses the mock, and a staging that isn't configured like production proves nothing about production.

**Rehearsed locally** (§7, scenarios 2 and 3), with the mock provider held at 50 s behind nginx:
- with a 30 s proxy timeout, the check failed with *"a proxy answered 504 after 30.0 s: its timeout is below the server's 120 s"*, which is the SRS §8 failure reproduced and correctly named;
- with a 150 s proxy timeout, the check passed with *"a 50.0 s analysis completed through the proxy"*.

## 5. Rolling deploys and the drain (NFR-3.5)

`deploy-api` must replace instances one at a time, give each one a stop grace period above the 90 s drain, and return only once every instance runs the new image. The smoke check then proves the last part. **Many platforms default the grace period well below 90 s.** Check it in the platform's settings when you choose one, and record the value here.

**Rehearsed locally** (§7, scenario 4): both instances were recreated one at a time while a 50 s analysis was in flight, with a smoke probe running every two seconds throughout. The analysis completed (200 after 50.0 s) and 23 of 23 probes passed. The per-instance timings show that SIGTERM really did reach the instance holding the request: that instance took **42 s** to replace, because it waited out the drain, while the idle one took **3 s**.

**And it can fail.** The rehearsal was run again with the stop grace period cut to 10 s, the stand-in for a short platform default. The instance holding the analysis was killed ten seconds after SIGTERM, the analysis was cut at 20.8 s, and scenario 4 failed while every other scenario passed. That same run caught a wrong message in the check itself: it reported the 502 as *"its timeout is below the server's 120 s"*, which blamed the proxy for an instance the orchestrator had killed. A 502 now reads *"the instance serving the request went away mid-request … check the platform's stop grace period"*, and a test pins the difference between 502 and 504.

## 6. Rolling back

**The API: redeploy the previous image.** Run the Deploy workflow by hand (Actions → Deploy → Run workflow) with `rollback_to` set to the full SHA of the commit to go back to, and `rollback_what: api`. That puts production's API on that commit's already-built image, behind the same approval, then smokes and watches it.

There is **no migration step, on purpose.** Migrations only move forward. The previous image runs on the current schema because every migration is expand-only (SRS §5.5, [migrations.md](migrations.md)). A rollback that needed a down-migration would be a new deploy, not a rollback, and it's exactly what §5.5 exists to prevent.

**The frontend: independently** (PRD §15). The same workflow with `rollback_what: frontend` rebuilds that commit's client against production's API and publishes it. The client build depends only on its commit and `VITE_API_BASE_URL`, so rebuilding a commit reproduces that commit's client. Most static hosts can also re-promote a previous deployment from their own dashboard, which is faster in an emergency and just as valid.

**When to roll back:** the watch failed, or a Sev-1/Sev-2 alert began with the deploy, and the problem isn't something the feature switch (`ANALYSIS_ENABLED=false`) contains. For a provider incident, a spend ceiling or a prompt regression, PRD §15 says the switch is the right response, not a rollback.

**Rehearsed locally** (§7, scenario 5). The "previous" image was **`a4ee3e3`**, the last commit **before the newest migration existed**. It is the hardest rollback available today: code that has never seen the current schema, on a database where the current code has already written rows. The newest migration (`20260928040013_job_run_failure`) includes `ALTER COLUMN "lastSuccessAt" DROP NOT NULL`. Relaxing a constraint looks like an expand, but old code was generated to treat the column as always present, so it may choke on a NULL. The rehearsal checked this directly:
- the current image had written a `JobRun` row with `lastSuccessAt` NULL (a job that failed before it ever succeeded);
- after the rollback, the old image's own read of every `JobRun` row (its metrics gauge's `findMany`) **read all 3 rows without error**, and the old code's `at ? … : 0` already treats a missing time as "never";
- smoke passed (every instance on `a4ee3e3`, ready, signed-in round trip), and an analysis on the old image returned 200.

**So this migration is rollback-safe, and now that's measured rather than assumed.** The general lesson goes into [migrations.md](migrations.md)'s review: relaxing a constraint is an expand only if the old code tolerates the new values, so check that and don't take it for granted.

## 7. The local rehearsal

`ops/deploy/rehearsal/run.sh`: two API instances of one image behind nginx, with the proxy timeout as a parameter and the drain as each instance's stop grace period. It builds the current and the previous image, runs the seven scenarios, and removes the stack when it finishes, pass or fail. It takes about six minutes. **CI runs it on every pull request** (the `deploy-rehearsal` check, required by branch protection), so a migration the previous code cannot survive fails before merge, not on the day someone needs to roll back. It runs `NODE_ENV=development` with the mock provider, **so it is not staging**. Production mode refuses the sink email provider and the mock. What carries over to staging is the behaviour of **this code** under a proxy, a rolling restart and a rollback. What doesn't carry over is anything about the platform's own proxy and orchestrator. That's why every check the rehearsal used is also a step in `deploy.yml`, pointed at staging.

| Date | Scenario | Result |
|---|---|---|
| 2026-09-29 | 1. migrations as a discrete step, with no API running | 7/7 applied from the host (`npx prisma migrate deploy`, the command `deploy.yml` runs), before any instance existed |
| 2026-09-29 | 2. 50 s analysis, 30 s proxy | **cut**, correctly: *"a proxy answered 504 after 30.0 s"* |
| 2026-09-29 | 3. 50 s analysis, 150 s proxy | completed, 50.0 s |
| 2026-09-29 | 4. rolling restart during a 50 s analysis, smoke probes throughout | analysis completed (50.0 s); 23/23 probes ok; the instance holding it took 42 s to replace, the idle one 3 s |
| 2026-09-29 | 5. rollback to `a4ee3e3` on the current schema, facing a row only the current code writes | smoke ok on `a4ee3e3`; analysis 200; old code read the NULL row |
| 2026-09-29 | 6. roll forward | smoke ok on the current image |
| 2026-09-29 | 7. `e2e/staging.spec.js`: the built client served statically against this API, nothing mocked | passed in 53 s (sign in, a 50 s analysis, report, history, delete, sign out), axe clean on login, upload, analyzing, report and history; none of its documents left behind |

The rehearsal was also run **broken on purpose**, to show that scenario 4 can fail (§5): stop grace period 10 s → scenario 4a failed, and only 4a. Scenario 2 is the built-in version of that for the timeout chain: it passes only if the check reports a truncated analysis as a failure.

Two defects were found by running this, not by reading it: the check's 502-versus-504 message (§5), and a selector in `e2e/staging.spec.js` that also matched the report's "Back to history" link. Scenario 7's first run failed on the selector after the sign-in, the 50 s analysis and four axe scans had all passed, and scenario 7b correctly reported that the failed run had left its document behind.

## 8. Decisions made in step 71

1. **The partly exposed `ANTHROPIC_API_KEY` (step 70's incident) is rotated.** The project's own rule is "a leaked key is deleted in the console and replaced", and [secret-rotation.md](runbooks/secret-rotation.md) treats "printed in a log or a chat" as Severity 1: rotate first, investigate second. It was never committed (the full history scans clean), but it appeared in a session transcript, and that counts. **The owner does this** in the Anthropic console; the new value is placed by the owner in `server/.env` and never passes through anyone else. The new key is for development only. Staging and production each get their own (§1).
2. **Branch protection is applied in this order**, and not before: the owner pushes `main`; CI runs on that push and every required check reports once; `gh` is installed and authenticated (`gh auth login`); then `scripts/configure-branch-protection.sh` runs (after `--dry-run`). If the first CI run on GitHub fails, the failure is fixed first. Protection that requires a check which has never passed would lock the branch. Nobody but the owner pushes, and there is no `gh` on the machine these steps were built on.
3. **A failed weekly scan opens (or comments on) one GitHub issue** labelled `dependency_critical_vuln`, from the `report` job in `scan.yml` (`scripts/report-scan-failure.sh`). It needs no provider account, it timestamps the start of SRS §2.1's seven days, and closing it is the runbook's record. **The repository is public**, so the issue names the failed scan and links the run, but never the package. A failed **secret** scan is deliberately **not** reported this way: a public issue pointing at a leaked credential before it's rotated would be worse than silence. That one reaches the owner as GitHub's failed-run email. `scan.yml` gets its first run by hand (`workflow_dispatch`) right after the first push.
4. **`DEPLOY_ENV`, and the mock refused in production mode** (§1).
5. **A blank environment variable is an unset one.** Found by booting from a copy of `.env.example`: every optional `NAME=` line failed validation as an empty string (`LLM_TIMEOUT_MS=` became 0). Hosting dashboards produce the same blank values.
6. **Migrations for a deploy run from the CI runner**, from the commit being deployed (§2). The platform's one-off job is the documented fallback.

## 9. Decisions still owed (the owner's)

Each of these blocks staging, and so blocks this step's "done when":

1. **The hosting platform for the API**, which must run a Docker image, at least 2 instances, a stop grace period over 90 s, and a proxy idle timeout over 120 s (SRS §8 names Render or Railway). Then implement its case in `scripts/deploy/platform.sh`.
2. **The static host for the frontend** (Vercel or Netlify, SRS §8), and its case in `platform.sh`.
3. **Managed Postgres (with PITR) and managed Redis.**
4. **A transactional email provider and a verified sending domain.** Until one exists, **no production-mode process can boot at all**, staging included: `config.js` refuses the sink in production mode, correctly (BUILD-PLAN step 51's note: "Step 71 is where this bites").
5. **Domains and TLS** for the API and the frontend of each environment.
6. **Staging's own provider key** with its own spend ceiling, created in the Anthropic console and put **only** in the platform's staging secret store.
7. **The GitHub environments, secrets and variables** in §2.
8. A metrics backend (optional for the watch, required for alerting; [ops/README.md](../ops/README.md)).

## 10. First deploy, in order

1. Decisions 1–6 of §9. Staging and production services exist, configured per §1, each with its own secrets in the platform's store.
2. `platform.sh` has the chosen platform's cases, with a stop grace period over 90 s configured on the service.
3. The GitHub environments, secrets and variables in §2 exist.
4. Branch protection is in place (§8, decision 2).
5. The smoke account exists in staging (§3).
6. Merge to `main`, and the pipeline runs. The first `verify-staging` **is** the staging proof of step 71's "done when": smoke, the long analysis (record its duration below), and E2E with axe.
7. Rehearse a rollback in staging: run the workflow by hand with the previous commit's SHA, and record it below.
8. Then repeat step 68's alert drills and step 69's runbook walkthroughs in staging (`ALERT_DRILL_TOKEN` is now allowed there).

### Staging log

| Date | What | Result |
|---|---|---|
| (none yet) | | |
