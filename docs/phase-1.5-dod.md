# Phase 1.5 definition of done

BUILD-PLAN step 75, the Phase 1.5 gate. PRD §9 lists seven items and PRD §15 the rollout stages. Each was checked on 2026-10-05 against the repository as of this file's commit. "Local" means this machine (an Apple M2 Pro laptop); it never means staging, and there is no staging yet ([deployment.md](deployment.md)).

**Verdict: NOT DONE. Do not launch, publicly or to a closed beta.** Two items are met locally and need repeating in staging. Item 3, the provider outage, is the one this step could settle end to end, and it is recorded in §3. Four items need things only the owner can provide: an external tester, a hosting decision and staging, a paging provider, counsel, and a person with a screen reader. None of the rollout stages has started.

| # | PRD §9 item | Verdict | Evidence |
|---|---|---|---|
| 1 | An external tester recovers a forgotten password and deletes their account unaided; verified afterwards, in the tables, that no rows remain | **Not done.** It needs an external tester on a deployed environment. The direct check is built and tested, and building it found a defect, now fixed | §1 |
| 2 | A restore from backup into a scratch database succeeds, its elapsed time recorded against the RTO | **Met locally: 18.6 s against the 4-hour RTO**, 695 MB, 2026-10-05. The managed provider's own restore is owed to staging | §2 |
| 3 | A simulated provider outage (529 for five minutes) gives a stated degraded-mode error, no data loss, nothing stuck PENDING, and ONE alert | **Met locally, after fixes.** As first configured it paged twice.

After the fixes, busy traffic passed every gate: **one page**, the provider's, 3.3 minutes in; 129 of 129 failed analyses got the stated 503; no data lost; nothing stuck; recovery in 10 s.

Quiet traffic, with the breaker never tripping, also gave **one page**, 5.0 minutes in. One gate failed there on the drill's own reader, which hit the per-address rate limit before the outage began. The reader is fixed, and that re-run is owed.

Staging is owed too (2026-10-05) | §3 |
| 4 | A load test at the target concurrency holds p95 within the SLO without exhausting memory | **Met locally: p95 25.1 s against 45 s at 20 in flight; worst instance 35.2% of 512 MB**, 2026-09-29. Staging is owed, on the real provider | §4 |
| 5 | Every Appendix C alert has fired, deliberately, **in staging**, and reached its destination | **Not done.** All nineteen fired locally into a real Alertmanager on 2026-09-28. Not in staging (there is none), and not to a real pager (none is chosen). Step 75 also found that drill's "one incident, one notification" result was wrong | §5 |
| 6 | Privacy policy, terms and subprocessor list live and linked from the footer and the upload screen | **Not done.** Built and linked, but not live (nothing is deployed), and still drafts that say so, with placeholders only the owner and counsel can fill | §6 |
| 7 | The accessibility audit's blocking defects closed, and the report committed | **Not done.** The report is committed; 3 of 3 defects found are fixed. The screen-reader pass, which SRS §7.15 makes mandatory, has not been done, so the audit is not closed | §7 |

---

## 1. Password recovery and account deletion, checked in the tables

**What exists.** Two operator commands, run on either side of the tester's deletion (`server/src/services/erasureCheck.js`):

```bash
# BEFORE the tester deletes their account: who it is, as ids and hashes only
npm run ops -- erasure-record --email <tester's address> --out erasure.json
# AFTER: asks Postgres and Redis directly, never an API route
npm run ops -- erasure-verify --in erasure.json --email <tester's address>
```

`erasure-verify` checks for three kinds of survivor, each a different way:

1. **A recorded row still there.** It looks up every recorded id in `User`, `AuthToken`, `Document`, `Analysis` and `Finding`, and anything still pointing at the user.
2. **A row nobody recorded.** This is SRS §12.4's "forgotten child table": a table added later, without `ON DELETE CASCADE`. Every text-like column of every table in the schema is searched for the user id and the address. The list of columns comes from the catalogue, not from code, so a new table is covered without anyone remembering to add it.
3. **State outside Postgres.** Every Redis key is scanned for the id and the address.

Audit events stay by design, keyed by an HMAC of the user id. They are counted and reported, never treated as a failure, and check 2 confirms they hold neither the id nor the address in plain. Two things are reported as **not checked**, rather than left implied: backups, which keep the account until they age out (30 days, PRD §12.4), and subprocessors' own copies, such as the email provider's delivery logs.

**What building it found: deletion left the account's counters in Redis.** Before step 75, deleting an account removed every row, but not these keys:

| Key | What it holds | Lifetime |
|---|---|---|
| `quota:month:<id>:<period>` | the account's monthly analysis count | 62 days, longer than the 30 days the privacy policy gives backups |
| `quota:hour:<id>`, `rl:analyze:user:<id>` | hourly counters | 1 to 2 hours |
| `rl:forgot-email:email:<address>` | the forgot-password limiter, keyed by **the address itself** | 1 hour |

That last key is exactly the trail a tester doing this item's flow leaves. Erasure now removes these keys after the deletion commits (`forgetAccountKeys` in `services/account.js`). It is best effort and logged: a Redis outage must not turn a completed deletion into a 500, and every one of the keys expires on its own anyway.

**And an address is matched as a whole address, never as a substring.** The check's first version searched for the address as a substring. Its own test's decoy account then failed it: `xerasure-clean@…` contains `erasure-clean@…`, so the check reported a different person's row and counter as the deleted account's residue. Erasure would have reset that person's counter too.

Both now use one pattern (`lib/wholeAddress.js`): the address may not be preceded by a character that could continue its local part, nor followed by one that could continue its domain. A test runs the same cases through JavaScript (for Redis) and Postgres (for the column sweep), so the two cannot disagree about what a match is.

**Tested** (`server/tests/integration/erasureCheck.test.js`, against real Postgres and Redis):

- after a deletion through the real `DELETE /api/v1/account` route, the check reports every table at 0, a sweep of every text column empty, and no Redis key; the two audit events are retained;
- **before** the deletion it finds all of them, so a CLEAN result is not vacuous;
- it finds a row it was never told about (the id in a text column of another table) and a Redis key nobody removed;
- it refuses a record taken for a different address;
- another account's counters survive, including one whose address contains this one's, and neither its row nor its key is reported;
- JavaScript and Postgres agree on what a whole address is.

Five mutations of the erasure code were tried in an isolated copy of the tree:

- erasure leaves the Redis keys;
- a whole address is any substring;
- erasure's Redis match is a plain substring;
- the column sweep sweeps nothing;
- CLEAN ignores Redis.

Each was killed by the test written for it.

**Owed, by the owner.** The item itself needs three things in order:

1. A deployed environment with real email. Phase 1 DoD item 1, a public URL over HTTPS, is still open.
2. A tester who is not the owner and has not been shown the flow.
3. `erasure-record`, the tester's own recovery and deletion with nobody helping, then `erasure-verify`. Record its output here.

## 2. Restore timed against the RTO

**Met as PRD §9 words it, locally.** `scripts/restore-drill.sh` was run on 2026-10-05 at the projected year-one volume: 5,000 accounts, 20,000 documents, 120,000 findings and 250,000 audit events. The synthetic database was **695 MB** and its `pg_dump -Fc` 300 MB.

The RTO clock ran **18.6 s against 4 h**:

| Phase | Time |
|---|---|
| Provision | 1.7 s |
| `pg_restore` | 12.9 s |
| Verify (every count and both checksums identical, schema up to date) | 2.4 s |
| API ready | 1.4 s |

The drill's check was shown able to fail: one finding deleted after the restore stopped it with exit 1. The full record is in [runbooks/database-restore.md](runbooks/database-restore.md).

**Not covered:** the managed provider's own restore or point-in-time recovery. None is chosen. That part of the 4 hours is the one that needs measuring for real, and only staging can measure it.

## 3. A provider outage: one alert

Built in this step: `ops/drills/provider-outage/`. The drill runs the deploy rehearsal's stack plus three pieces:

- **Prometheus**, running the committed `ops/alerts/alerts.yml`;
- **Alertmanager**, running the committed `ops/alerts/alertmanager.yml` with only the two receiver URLs changed (`run.sh` checks that nothing else differs);
- **a recorder**, which writes down every webhook Alertmanager sends.

The outage is the mock provider answering **529 to every call** while a file exists in both API containers. The run is a 7-minute baseline, the 5-minute outage, then watching until every alert has resolved.

Traffic keeps running throughout: one user uploading and analysing a fresh document every few seconds, and one reader listing documents and opening reports from before the outage once a second. The verdicts are computed by `drill.mjs`, whose gates are unit-tested so that none can pass on missing evidence (`server/tests/unit/outageDrill.test.js`).

### First run: the committed configuration paged twice

Run on 2026-10-05, from 07:53 UTC (outage start), on busy traffic:

| | |
|---|---|
| Degraded-mode error | **86 of 86** failed analyses during the outage answered 503 `LLM_UNAVAILABLE`, with `Retry-After: 60` and "Your document is saved — try again in about a minute." |
| Reads | 200 during the outage, all 200, and every pre-outage report still the same `COMPLETED` analysis |
| Data | the digest of every pre-outage row identical before and after; 86 of 86 documents uploaded during the outage kept, and 5 of 5 re-analysed once it was over |
| Stuck analyses | none `PENDING`, none reaped, every failure `LLM_UNAVAILABLE` |
| Alerts | **two pages, 25 seconds apart**: `analysis_failure_rate` (provider) 2.0 minutes in, and `api_5xx_rate` (platform) 2.4 minutes in |

Degraded mode worked. The alerting did not.

**Why the design on paper did not hold.** `alertmanager.yml` relied on `circuit_open` inhibiting the other two, but inhibition only applies once its source is **firing**. `circuit_open` waits five minutes by Appendix C's own condition ("open > 5 min"), while the two symptoms fire within two. In a five-minute outage `circuit_open` never fired at all: the breaker read open for 4.75 minutes.

Step 68's drill had passed "one incident, one notification" by posting all four alerts to Alertmanager at once. That is not how an outage delivers them.

**What else the run showed about the breaker.**

- **No trial ever happened.** There were four openings in five minutes and not one `circuit_trial`. The open key's lifetime was exactly the open period, so it vanished at the instant the period ended and the half-open state never existed.
- **The gap let calls through.** Every request in the gap went to the provider with its full retry budget: 46 provider calls during the outage, against the one trial a minute FR-3.12 describes.
- **The test could not catch it.** The integration test moved the clock forward instead of letting the key expire.
- **The gauge was exposed to it.** `llm_circuit_state` read 0 in each gap. This run's busy traffic made the gaps short enough that no scrape caught one, but on quieter traffic they would have reset `circuit_open`'s five minutes every minute.

**And two things about the drill itself.**

- **A mock artifact.** `risk_drift_high` fired as a digest. The mock claimed "medium" risk over a high-severity finding of its own, which made every analysis a drift. The three-minute baseline was shorter than the five-minute rule group's interval, so the alert first evaluated during the outage and looked like part of it.
- **The laptop slept.** It went into idle sleep 2.4 minutes into the outage, 3 seconds after the second page, and slept on and off for an hour. Both pages were sent before that, but every timing after it is unusable, including one dropped connection at 38 minutes.

### The fixes

| What | Change |
|---|---|
| **One failure, one owner** | `api_5xx_rate` subtracts failed analyses (`analysis_total{outcome="failed"}`). Every way an analysis can fail is answered 5xx and counted there, and `analysis_failure_rate` already pages on them, with the error code. What `api_5xx_rate` covers is now what no other alert owns: reads, sign-in, uploads, and the analyze route failing before an analysis exists. Appendix C's threshold and window are unchanged. Three new promtool cases pin it: an outage's failed analyses do not page the platform; a platform failure beside them still does; and an analyze-route 503 from before an analysis exists still does. |
| **The breaker's half-open state** | The open key now outlives the open period (`TRIPPED_TTL_MS` = 60 s + 5 min). Once the period is over, exactly one trial goes through; a failed trial opens the breaker again for a full period with a fresh trial slot. If no call comes at all, the key lapses. Three new integration tests cover this, one of them on the key's real lifetime rather than a moved clock. |
| **A gauge that does not flap** | `llm_circuit_state` is 1 while the breaker is tripped, half-open included. |
| **The mock** | In `quote-document` mode it claims the risk its own findings derive to. |
| **The drill** | A 7-minute baseline, and a gate that every rule group evaluated on baseline traffic. A validity gate fails the whole run if the host stalls for more than 30 s. `run.sh` holds the machine awake (`caffeinate`). |
| **The record** | The runbooks ([provider-outage](runbooks/provider-outage.md), [analysis-failure-rate-high](runbooks/analysis-failure-rate-high.md)), `alertmanager.yml`'s header and [alert-drills.md](alert-drills.md) now say how an outage actually pages. They used to say `circuit_open` would be the only page. |

### After the fixes

**Busy traffic, 2026-10-05, outage 12:57:28 to 13:02:28 UTC: every gate passed.** The run lasted 30.5 minutes, the machine was held awake, and no loop paused for more than 30 s.

| Gate | Result |
|---|---|
| A valid run | 1,819 reads and 183 alert polls, no gap over 30 s |
| A clean baseline | all 7 rule groups evaluated on 7 minutes of baseline traffic; nothing pending, firing or sent |
| The stated degraded-mode error | **129 of 129** failed analyses answered 503 `LLM_UNAVAILABLE`, `Retry-After: 60`, with the document-is-saved message. 110 were refused by the breaker in under half a second; 19 failed after their retries, before it opened |
| Nothing else failed | 433 analyses, every non-200 a 503 `LLM_UNAVAILABLE` inside the outage and its recovery; no 500, no dropped connection |
| Reads unaffected | 1,819 reads, 300 of them during the outage, all 200, every pre-outage report still the same `COMPLETED` analysis |
| No data loss | the digest of every row from before the outage identical before and after (`ea2da6d4…`) |
| Outage uploads kept | 129 of 129 documents uploaded during the outage still there; 5 of 5 re-analysed once it was over |
| Nothing stuck | 0 `PENDING`, 0 reaped, every failure `LLM_UNAVAILABLE` (132: the 129, and 3 refused in the seconds before the first success) |
| Recovery | first successful analysis **10 s** after the provider recovered |
| **ONE alert** | **one group, one page**: `analysis_failure_rate` (provider, on the pager) **3.3 minutes** in, and its resolution 23.3 minutes in. Two messages, one incident |
| It names the cause | the provider, on the pager |

The breaker now behaves as FR-3.12 describes. It opened once (1.25 minutes in, once 20 calls in its window had half or more failing). After that came one trial per minute: 4 trials, 3 of them failing and re-opening it, and the fourth closing it after the provider recovered. `llm_circuit_state` went to 1 once and back to 0 once, with no flapping. `circuit_open` did not fire: the breaker was tripped for 4 minutes, under its 5. Had it fired, it would have joined the same notification.

Provider calls during the outage came to 58: the calls that tripped the breaker, then each trial request's own retries. That is more in total than the first run's 46, because a longer baseline put more successes in the window, so tripping took longer. It is not more after the trip, which is when the breaker is supposed to be doing its job.

**Mutation tests** of the fixes, run in an isolated copy of the tree:

- the open key living exactly `OPEN_MS` again (the drill's bug);
- a failed trial not re-opening;
- half-open read as closed (the flapping gauge);
- `api_5xx_rate` counting failed analyses again;
- `api_5xx_rate` dropping the analyze route altogether;
- the drill's validity, baseline and one-alert gates each loosened;
- the mock claiming "medium" again.

Every one was killed by the test written for it. Nine in all here, and five more in §1. A copy, because a development server watching the working tree had loaded a mutation once before (see "The README's numbers").

**Quiet traffic** (an analysis a minute, which never trips the breaker):

**2026-10-05, outage 13:38:15 to 13:43:15 UTC: one alert, and ten of eleven gates passed.** The eleventh failed on the drill's own traffic, not on the product. The run lasted 17.8 minutes, and no loop paused for more than 30 s.

| Gate | Result |
|---|---|
| **ONE alert** | **one group, one page**: `analysis_failure_rate` (provider, on the pager) **5.0 minutes** in, and its resolution 10.0 minutes in. No `api_5xx_rate`. The breaker never tripped: 15 provider calls (5 analyses, 3 attempts each) is under its 20-call minimum, so there was no `circuit_open` and `llm_circuit_state` stayed 0 |
| The stated degraded-mode error | 5 of 5 failed analyses: 503 `LLM_UNAVAILABLE`, `Retry-After: 60`, the document-is-saved message |
| Nothing else failed | 17 analyses, no 500, no dropped connection |
| Data, uploads, stuck analyses | digest identical before and after; 5 of 5 outage uploads kept and re-analysed; 0 `PENDING`, 0 reaped |
| Recovery | 31 s after the provider recovered |
| **Reads unaffected: FAIL** | **43 of 1,021 reads answered 429**, all of them report reads for the same owner, every 14 s, **starting 1.2 minutes before the outage began**. NFR-2.6's general limit is 100 requests per 15 minutes per address. With only seven reports finished in a quiet baseline, the drill's reader spent one owner's whole allowance on its own. That is the limiter working, against the drill. |

**What the failure is, and what was done about it.** The 429s started before the outage, so the outage did not cause them. But a gate failed, and it is not overruled here.

The reader now keeps every address it uses within 90 requests in any 15 minutes (`AddressBudget`, unit-tested, and mutation-tested by letting the budget never run out). A re-run of the quiet drill is owed. It was not done on 2026-10-05 because the battery was at 8%.

**What the quiet run adds to the busy one.** The single page holds when the breaker never trips, so it does not depend on `circuit_open`. On a quiet day the page comes later: 5.0 minutes, against 3.3 on a busy one. The ratio needs enough failures inside its 15-minute window to pass 25%, and a quiet day supplies them slowly. A shorter outage on a quiet day may not page at all. That is Appendix C's ratio as written, and what the owner's minimum-volume question below is about.

## 4. Load at the target concurrency

**Met locally, on 2026-09-29.** TR-21: 20 analyses in flight (NFR-1.3's target) for 10 minutes against two instances at 512 MB each, with no swap.

| | |
|---|---|
| Completed | 480 of 480, zero server errors |
| p95 | **25.1 s against NFR-1.1's 45 s** |
| Memory | worst instance **35.2%** of its limit, against 80% |
| Pool | never waited |

The provider was the mock, answering in a fixed 25 s. So the run measures the system's own overhead (about 0.1 s at p95) and its memory, not the real model's latency. The one real measurement of a document near the length cap is a single sample: 3,886 words on `claude-sonnet-5`, 25.8 s, on 2026-09-24.

Three caveats:

- **TR-21 is unaffected by the mock's leak.** Step 75 found the mock provider had been retaining every document it was sent. That leaked about 6 MB per instance over TR-21's 10 minutes, nowhere near the 80% line.
- **The leak does affect TR-22, the two-hour soak.** Its "flat memory" reading is withdrawn and the soak is owed again ([load-test-results.md](load-test-results.md)). It was not re-run on 2026-10-05: the machine was on battery at 18%, and a soak needs two hours awake.
- **Staging is owed**, on the real provider.

## 5. Every alert fired, in staging

**Not done.** On 2026-09-28 all nineteen Appendix C alerts were fired deliberately on this machine and observed arriving at their destinations through a real Alertmanager running the committed configuration ([alert-drills.md](alert-drills.md)). Three things are missing:

- **Staging.** None of it happened in staging, because there is none.
- **A real pager.** No paging provider is chosen, so the last hop, a real pager waking a real person, has not happened.
- **`dependency_critical_vuln`.** The scan has never run on GitHub.

Step 75 found one of that drill's results wrong: "one incident, one notification" (§3 above). The end-to-end outage drill now stands in its place.

## 6. The legal surface, live and linked

**Not done.** What is done:

- `/privacy`, `/terms` and `/subprocessors` are built;
- they are linked from a footer on every layout and from the upload screen where the file is handed over;
- the no-training term is quoted verbatim from the provider's terms, with the date it was verified ([legal/README.md](legal/README.md)).

What is missing:

- **Not live.** Nothing is deployed.
- **Still drafts, and they say so.** Each page shows "Draft: not yet in force" for as long as a placeholder remains, and lists what is missing. Filling those in needs the owner: the operator, the contact addresses, the providers and their regions, the governing law and the liability clause.
- **Not reviewed by counsel**, which PRD §17 requires before launch.

## 7. The accessibility audit

**Not done.** [accessibility-audit.md](accessibility-audit.md) is committed:

- automated checks on all seven screens found zero violations;
- the keyboard-only pass of the whole journey is done;
- 3 of 3 defects found are fixed, each with a regression test.

**The screen-reader pass has not been done.** SRS §7.15 makes it mandatory, and nothing automated stands in for it. The script for it is §5 of the audit. Until a person runs it, the audit cannot close.

---

## Rollout (PRD §15)

| Stage | Gate | Exit criterion | Status |
|---|---|---|---|
| **Internal** | Phase 1 DoD | The owner runs ten real contracts through it and reads every report | **Not started.** Its gate is still open: Phase 1 DoD item 1 (deployed at a public URL over HTTPS) and item 2 (a person who is not the owner signs up and reads a report unaided) are outstanding ([phase-1-dod.md](phase-1-dod.md)) |
| **Closed beta** (up to 25 invited freelancers) | Phase 1.5 DoD | Two weeks with no Sev-1; at least 5 users complete signup → report unaided; feedback on whether findings were useful | **Not started.** Its gate is this file, and this file says not done |
| **Public** | Legal §12 items live; accessibility audit closed; alerts rehearsed | Announced publicly | **Not started.** None of its three conditions holds (§5, §6, §7) |

**Not launched, and not to be.** BUILD-PLAN step 75 says not to launch publicly until all seven items pass and the beta has completed. Neither is true.

What each stage should record here when it happens:

- **Internal:** the ten contracts' analysis ids, and any report the owner found wrong.
- **Closed beta:** the dates; the Sev-1 count (from `unverified_excerpt_displayed` and `cross_user_access`, both of which page); the five unaided journeys (signup to first report, from the `REGISTERED` audit event to the first `COMPLETED` analysis); and the feedback.
- **The README's cost, failure-rate and catch-rate numbers, measured again from the beta.** Today they come from development traffic on synthetic contracts, which the README says.

## The README's numbers (PRD §10.1, §11.4)

The README now quotes measured numbers, with their sample sizes and their sources:

- **Cost.** **USD 0.0192 per analysis** over the 32 real-provider analyses on the shipping configuration. It ranges from USD 0.0107 for a short clean contract to USD 0.0480 near the length cap, where measured input tokens ran to almost twice SRS §5.4's estimate.
- **Failure rate.** **0 of 29** analyses through the API path failed. That is consistent with a true rate up to about 10%, which the README says.
- **Hallucination-catch rate.** **1 of 137** reported findings was discarded by the verifier.

Two corrections were made on the way:

- **An accuracy claim had gone stale.** The README said every §11.1 gate passed. The 2026-09-28 benchmark run failed precision in its worst repeat, which phase-1-dod.md §8 already recorded.
- **The development database's analysis rows had been damaged by a mutation test.** On 2026-09-24 a reaper mutation was loaded by a development server watching the same files, and it marked every analysis `FAILED / STALE_ANALYSIS`. The original outcomes were recovered from `summary` and `overallRisk`, which only a completed analysis has: all 29 had completed. Step 75's mutation tests ran in an isolated copy of the tree.

## Owed, and by whom

**The owner:**

1. **Hosting, email and monitoring providers, then staging.** These unblock items 1, 2 (the managed restore), 4 (the staging run), 5 and 6, and Phase 1 DoD item 1.
2. **A paging provider**, for item 5's last hop.
3. **An external tester** for item 1, and another (or the same) for Phase 1 DoD item 2.
4. **Counsel and the legal placeholders** (item 6).
5. **A screen-reader pass** (item 7).
6. **The step-72 precision decision** (phase-1-dod.md §8).
7. **Whether the ratio alerts need a minimum volume before beta traffic.** At very low traffic, one failed analysis out of three is 33% and pages; `alerts.yml`'s header records this.

**Engineering:**

1. **The quiet provider-outage drill, re-run with the fixed reader, on mains power** (`DRILL_THINK_MS=60000 ops/drills/provider-outage/run.sh`).
2. **TR-22's soak, re-run on mains power** (`SOAK_MINUTES=120 ops/load/run-local.sh tr22`).
3. **The provider-outage drill and the restore drill, repeated in staging.**
4. **A database outage, which has not been drilled.** `readiness_failing` inhibits its symptoms with the same timing limit `circuit_open` had: it waits two minutes, while `api_5xx_rate` fires in one. They are in the same group, so it would be one page, but in-flight analyses failing could also page `analysis_failure_rate` separately.
