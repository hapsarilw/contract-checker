# Load, soak and end-to-end results

BUILD-PLAN step 73 (OPS-10): SRS §10.6's TR-21 to TR-23, §10.7's TR-24, NFR-1.3, and §6.1's capacity model.

**Status, 2026-09-29: all four pass on the local rehearsal stack, and none has run in staging, because there is no staging** ([deployment.md](deployment.md)). One real defect was found and fixed on the way: the upload flood killed both instances. Everything below says where it ran. "Local" never means "staging".

| Done when (BUILD-PLAN step 73) | Local rehearsal, 2026-09-29 | Staging |
|---|---|---|
| TR-21 holds p95 under 45 s with no instance over 80% memory | **Pass**: p95 25.1 s, worst instance 35.2% | not run |
| TR-22 shows flat memory over 2 hours | **Pass, narrowly**: api1's RSS trend is 12.71 MB/h against 12.8 allowed, and falling to 2.2 MB/h in the last 30 minutes (see TR-22) | not run |
| TR-23 returns 503 rather than OOM-ing | **Pass, after a fix**: see "The upload flood" | not run |
| TR-24 completes the full journey with axe assertions on every screen | **Pass**: 7 screens, 30.0 s | not run: needs a readable staging inbox ([deployment.md](deployment.md) §9) |
| Results committed with dates and configuration | this file | |

## Configuration

| | |
|---|---|
| Where | the local rehearsal stack: `ops/deploy/rehearsal/compose.yml`, driven by `ops/load/run-local.sh` |
| Machine | Apple M2 Pro, 10 CPUs; Docker Desktop 29.7.2, its VM at 7.7 GiB |
| Code | `1a372c8` plus this step's changes, committed together with this file |
| API | 2 instances of one image, `NODE_ENV=development` (the sink email provider is refused in production mode, as is the mock) |
| Memory | **512 MB per instance and no swap** (`mem_limit` = `memswap_limit` = 512m): SRS §6.1's "two instances at 512 MB each". `MEMORY_LIMIT_BYTES` matches. |
| Database | Postgres 15, `DATABASE_POOL_SIZE=10` per instance (§6.1: instances × pool under the server's limit) |
| Proxy | nginx 1.28, 150 s timeouts, round robin |
| Provider | the mock, answering every analysis after **25 s**, with findings quoting the document (`MOCK_LLM_FINDINGS=quote-document`) |
| Document | the longest the product accepts: fixture 05's synthetic MSA cut to 3,919 words, under FR-2.6's 4,000 (NFR-1.1 is stated "at the 4,000-word limit") |
| Rate limits | **on**, at production values. Load accounts are made with `npm run ops -- load-accounts`, enough that none reaches 10 analyses an hour, and each account is one user at one address (the rehearsal's nginx honours `X-Load-Client-IP`). |
| Sampling | every 10 s (every 1 s for TR-23), from each instance directly: RSS, memory limit, `db_pool_in_use` and `db_pool_waiting` from its own `/metrics`; Postgres's connection count; and, for TR-23, each container's cgroup (`memory.peak`, `memory.swap.max`, `memory.events`) |

**Why 25 s of mock latency.** It is an assumption, stated as one. The real benchmark (step 72) measured 2.5 to 16 s for documents of about 900 words, and nothing has measured a 4,000-word document on the real model yet. With a fixed provider latency, what TR-21 measures is everything else: the system's own overhead on top of the provider, and whether memory, the pool and the process hold at 20 in flight. The p95 of 25.1 s against 25.0 s of provider time is that overhead, about 0.1 s. What it cannot tell you is the real model's p95 at 4,000 words. That is the staging run's job, on the real key.

## TR-21: 20 analyses in flight, 10 minutes

| | |
|---|---|
| Analyses | **480 of 480 completed**, 0 failed, 0 server errors |
| In flight | 20 throughout (peak 20) |
| Analysis time | p50 25.03 s · **p95 25.11 s** · p99 25.13 s · max 25.17 s, against NFR-1.1's 45 s |
| Memory | worst instance **180 MB, 35.2%** of 512 MB |
| Database pool | peak 6 in use, **0 waiting** in every sample; Postgres connections 5 to 21 |

**Pass.** One limit of the method: the pool gauges are sampled every 10 s, so a wait shorter than that could fall between samples. What argues against one happening is that p95 sits 0.1 s above the provider's own time, with no 500s.

## TR-22: 2 hours at moderate load

05:59 to 08:10 UTC for the whole final run, the soak being its last 120 minutes. 5 analyses in flight, 110 accounts.

| | |
|---|---|
| Analyses | **1,440 of 1,440 completed**, 0 server errors, p95 25.05 s |
| Duration sampled | 120.2 minutes, 662 samples per instance |
| Memory | worst instance 201 MB, **39.3%** of 512 MB |
| RSS trend after the 10-minute warm-up | **api1 12.71 MB/h · api2 7.99 MB/h**, against **12.8 MB/h** allowed (5% of the limit over two hours) |
| Postgres connections | 5 to 12 throughout, trend 0.04 per hour |
| Database pool | peak 3 in use, 0 waiting |

**Pass, and by 0.7% on api1, so it is examined here rather than just recorded.** A leak grows at a steady rate. This growth slowed down:

| RSS trend (MB/h) | minutes 10 to 60 | 60 to 120 | last 30 |
|---|---|---|---|
| api1 | 13.9 | 8.9 | **2.2** |
| api2 | 5.4 | 8.4 | **1.4** |

Averaged over 15-minute windows, api1 went 172.8, 182.6, 183.6, 188.3, 191.8, 196.4, 198.2, 199.1 MB: about 27 MB in two hours, **flattening toward roughly 200 MB**. That is the shape of a process still warming up (V8 sizing its heap, code and allocator caches filling) and settling, not of a leak, which would still be climbing at 13 MB/h at the end. But two hours cannot prove the plateau; it can only show the slowdown.

**What should follow:**
- the staging soak should run longer than two hours;
- a leak would show there as a trend that does not fall;
- Appendix C's `memory_high` alert (RSS > 80% of the limit) is the production backstop for the case where this reading is wrong.

The threshold was set before the run and has not been changed after seeing the result.

## TR-23: 50 simultaneous 5 MB uploads, and the defect it found

**The final run passes:**

| | |
|---|---|
| Uploads | 50 at once, 4.85 MB PDFs, each from its own account and address |
| Outcome | **20 accepted (201), 30 refused with 503 `SERVER_BUSY`**, 0 other errors |
| Memory, per cgroup | peak **297 MB and 276 MB** of 512 MB; **never reached the limit** (`memory.events max` 0); swap 0; `oom_kill` 0 |
| Afterwards | both instances running, `/api/ready` 200 |

It did not pass the first time, and the way it failed first is the most useful result in this file.

**Run 1: passed, and meant nothing.** 20 accepted, 30 refused, no OOM kill, RSS "60%". The memory samples were 10 s apart, and a flood that lasts seconds fits between them.

**Run 2: sampled every second, still "passed".** The RSS peak was now **559 MB: 109% of a 512 MB limit**, with no OOM kill. That should not be possible, so the containers' cgroups were read. `memory.peak` was **exactly 536,870,912 on both instances**. `memory.events max` showed the limit was hit **685 and 354 times**. `memory.swap.peak` was **272 MB and 146 MB**. The instances survived only because Docker gives a container as much swap again as its memory limit, and the kernel swapped instead of killing. Container platforms do not give swap.

**Run 3: no swap (`memswap_limit` = `mem_limit`), the platform's reality.** **Both instances were killed.** 17 uploads got 502 as their instance died under them, only 4 were accepted, and `/api/ready` never came back.

**The cause: SRS §6.1's capacity model counts the wrong thing.** It bounds upload memory at `MAX_CONCURRENT_UPLOADS` (10) × 5 MB = 50 MB. But every accepted upload is parsed in a worker thread (FR-2.11), and each worker is its own V8 instance holding a copy of the file. Measured directly, one process parsing the same 5 MB PDF 1, 2, 4 and 10 times at once, that is **35 to 50 MB per extraction**, and more for the first one. Ten at once on one instance is several hundred MB on top of a baseline of about 180 MB.

**The fix** (`server/src/services/extractionWorker.js`):
- **`MAX_CONCURRENT_EXTRACTIONS`**, default **2**, a semaphore on the worker. Uploads are still accepted up to FR-2.12's 10. Only two are parsed at once per instance, and the rest wait a fraction of a second each. A slot is released when the worker has **exited**, not when it answers, because its memory is only returned then. The wait does not count toward FR-2.11's 10 s. The queue is bounded by FR-2.12's cap.
- **A heap ceiling per worker** (`maxOldGenerationSizeMb` 128), so a pathological document can kill its own worker (a 422) and never the instance.

**Run 4, the same flood and the same no-swap limits: the pass above**, 279 to 297 MB peak, and 0 times at the limit. The system under test differs between runs 3 and 4 in this fix alone. The harness also changed between them: it now reads the containers before the flood as well as after it, because run 3's inspection only looked at survivors and reported "not inspected" when there were none.

**For the owner: SRS §6.1 and Appendix B should say this.** The capacity model's "10 × 5 MB bounds upload buffering at 50 MB" is true of buffering and false of memory. The bound that matters is `MAX_CONCURRENT_EXTRACTIONS` × (worker + file). `MAX_CONCURRENT_EXTRACTIONS` is new and not in Appendix B's inventory. Raising it, or `MAX_CONCURRENT_UPLOADS`, means re-running TR-23, and `config.test.js` pins the default so that cannot happen by accident.

## TR-24: the whole journey, in a browser

`client/e2e/journey.spec.js` covers register → verify with the token from the email the API really sent → upload fixture 01 through the file picker → the report → copy a suggested change (the clipboard holds exactly the card's text) → delete the document → delete the account → the old credentials no longer sign in.

It ran against the built client served statically and the rehearsal's API, with nothing mocked in the browser. **It passed in 30.0 s.** The axe scans (WCAG 2.0 to 2.2, A and AA, as in step 65) found **zero violations** on all seven screens: register, upload, analyzing, report, history, settings, and sign-in.

**Why the mock "quotes the document" now.** The mock's report used to be empty, so "copy a suggested change" had nothing to copy. `MOCK_LLM_FINDINGS=quote-document` makes an unscripted mock analysis return up to three findings that quote whole sentences of the document verbatim. They pass §5.3's real verification, and so reach the report. It applies to the mock only (config refuses it otherwise), and the default is still the empty report every other test relies on.

**In staging, it cannot run yet.** Its verification step reads the email through `E2E_MAILBOX`. Locally that is the mail sink. Staging runs in production mode, which refuses the sink, so it needs whatever test inbox the chosen email provider offers. It is wired into `deploy.yml`'s `verify-staging` and **fails there until that exists**, deliberately: skipping it would report email as working when nothing had checked.

## Running it again

```sh
ops/load/run-local.sh                     # TR-23, TR-24, TR-21, TR-22: about 2 h 20 min
ops/load/run-local.sh tr21                # one
SOAK_MINUTES=20 ops/load/run-local.sh tr22
```

In staging, see [ops/README.md](../ops/README.md), "Load, soak and end-to-end". The generator itself is the same. What differs is where the samples come from (the metrics backend), how per-address limits are met (several load machines), and a check that the platform gives the service no swap.

## Log

| Date | Where | What | Result |
|---|---|---|---|
| 2026-09-29 | local | TR-23 run 1 (10 s sampling) | "pass", measured nothing: the spike fell between samples |
| 2026-09-29 | local | TR-23 run 2 (1 s sampling, Docker's default swap) | "pass": RSS 109% of the limit, cgroup at its limit 685 times, 272 MB swapped |
| 2026-09-29 | local | TR-23 run 3 (no swap) | **fail: both instances killed**, 17 × 502 |
| 2026-09-29 | local | TR-23 run 4 (no swap, extraction semaphore) | pass: 297 MB peak, never at the limit |
| 2026-09-29 | local | the final run: TR-23, TR-24, TR-21, TR-22 | **all four pass**: TR-23 297/276 MB peak and never at the limit; TR-24 7 screens clean, 30.0 s; TR-21 p95 25.1 s and 480/480; TR-22 1,440/1,440, memory trend 12.71 MB/h against 12.8 allowed and falling (05:59 to 08:10 UTC) |
