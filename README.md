# ClauseCheck

Freelancers sign contracts they don't fully read. The clauses that cause the most damage are boring to read and easy to skim past: unlimited revisions, net-60 payment terms, full IP assignment on work made before the contract started, termination-for-convenience with no kill fee. A lawyer review costs $150–500 per contract, which is economically irrational under about $5k of project value — so most freelancers just sign, and find out what they agreed to when the client invokes it. ClauseCheck is the structured, verifiable middle: a fast first pass that flags the handful of clauses worth a second look. Every finding quotes the contract verbatim and is checked against the source text before it is shown, so the user can confirm nothing was invented. That verifiability claim is the product.

**Status:** Phase 1 (the core working system) is largely built — register/sign in, upload or paste a contract, analyze it, read the report, and browse history all work end to end. Account settings (password change, sign out everywhere, export, delete account) is still a placeholder screen. Phase 1.5 (production hardening: email, quotas, the retention job, observability, deployment) has not started. Nothing is deployed yet.

## Architecture

```
Browser (React SPA, static)  ──HTTPS──▶  Express API  ──▶  PostgreSQL (Prisma)
                              ◀──JSON──                ──▶  Anthropic Messages API
```

The API is one Express app (`server/src/app.js`) with a fixed middleware order (SRS §2's diagram): request-id correlation → Helmet (CSP, HSTS) → CORS → the rate limiter → auth → per-route validation → Multer (upload routes only) → the route handlers → one global error handler. Every response — success or failure — carries the same `requestId`, and every error follows one shape: `{ error: { code, message, requestId } }`.

Two constraints hold everywhere in this codebase, because violating either one is a security or an availability incident, not a bug:

- **The LLM provider key exists only in the server's environment.** The browser never holds it and never calls Anthropic directly — every analysis goes through the Express API, which is the only thing that can spend money against the account or see the raw API response.
- **The API is stateless across instances.** Nothing may live in process memory that a later request depends on. This is why the one-PENDING-analysis-per-document guard is a database constraint (a partial unique index), not an in-memory lock — a lock only stops a race on the instance that holds it — and it's why the rate limiters count in Redis (`server/src/middleware/rateLimits.js`) rather than in process memory — a per-instance counter is not a slower version of the right limit, it is a different and wrong one, since a client spreading requests across N instances gets up to N times the stated ceiling.

  What happens when Redis itself is unavailable is a deliberate asymmetry rather than a single fallback (FR-5.6, `server/src/lib/failurePolicyStore.js`). **Analysis fails closed** — 503, no analysis — because every analysis spends provider tokens and an unmetered analyze path is a bill. **Reads and sign-in fail open**, because an unmetered history page costs nothing and refusing them would turn a degraded dependency into an outage. The decision is made per limiter, where the policy is known; by the time an error reaches the global handler every limiter's failure looks the same.

## The excerpt-verification defense

This is the part of the project actually worth reading, because it's the answer to the obvious objection: **an LLM will confidently invent a quote that sounds exactly like it belongs in the contract, and a user has no way to tell a real clause from a fabricated one just by reading the report.** A "finding" that quotes text the contract doesn't contain isn't a minor bug — it's the product lying to someone about a document they're about to sign, in the specific way a "trustworthy first pass" is supposed to prevent.

So nothing the model says ships as-is. Every finding's `clause_excerpt` is checked against the actual, stored document text (`server/src/services/verify.js`) before it ever reaches a response. The match is **case-insensitive, whitespace-collapsed, and tolerant of curly-vs-straight quotes** — a real clause reflowed or retyped by the model still matches — but it is a **strict substring match, never a fuzzy one.** PRD decision D9 states this outright: no near-miss tolerance, ever, because near-miss tolerance is exactly the hole a paraphrasing model would slip through. A model that rephrases a real clause "close enough" to sound plausible is indistinguishable, under fuzzy matching, from a model that invents one from nothing — the whole point of verification collapses the moment the matcher gets forgiving. Strict matching costs something measurable: an occasional legitimate finding gets discarded because the model lightly reworded it. That cost is tracked (`discardedFindings`, the `analysis_findings_discarded_total` metric) and is the thing to revisit with real data, not intuition, if it turns out to be too high (PRD §11.1's guardrail: over 10% discarded over 7 days).

The failure mode this closes isn't hypothetical, and it's asymmetric with how it fails: if the model reports findings and **all of them** fail verification, the analysis does **not** quietly become a clean report — it fails outright (`FAILED`, `ALL_FINDINGS_DISCARDED`, 502). An analysis that hallucinated everything must never look, from the user's side, identical to a contract that's actually fine.

## Failure handling

Every failure mode below returns the same `{ error: { code, message, requestId } }` shape (SRS §4) and states what to do next, not only what failed.

- **Malformed model JSON.** The response is parsed and validated against a Zod schema (`server/src/schemas/analysisResult.js`). On failure, the request is retried **exactly once**, with a correction message that quotes the specific validation error back to the model. A second failure gives up cleanly: `FAILED`, `LLM_INVALID_OUTPUT`, 502 — never a retry loop, never a raw parser exception reaching the client.
- **Every excerpt discarded.** Covered above — `FAILED`, `ALL_FINDINGS_DISCARDED`, 502, distinct from a genuinely clean contract (an empty `findings` array is a legitimate, successful result).
- **A scanned, image-only PDF.** `pdf-parse` returns little or no text from a rasterized page, which trips the 200-word floor (FR-2.5) the same way an accidentally-empty paste would — `DOCUMENT_TOO_SHORT`, 422, with a message that names a scan specifically, since it's the most common real-world intake failure, rather than a generic "too short" message that leaves a user staring at a file they know isn't short. Exercised directly by fixture 06 (`server/tests/fixtures/`).
- **Provider outages.**
  - **The client side.** Transient failures (429, 5xx, 529) are retried twice with full-jitter backoff (FR-3.10). A circuit breaker shared through Redis stops calling a failing provider for 60 s at a time, then lets exactly one trial through (FR-3.12). The user is told `LLM_UNAVAILABLE`, 503, with `Retry-After` and "Your document is saved", and the upload screen shows a degraded-mode banner.
  - **The alerting side.** Step 75 drilled it end to end with real Prometheus and Alertmanager (`ops/drills/provider-outage`). On the configuration as first written, a five-minute outage paged twice, and the breaker never held its half-open state. Both were fixed. Busy or quiet, the outage now pages **once**, with nothing lost and nothing stuck. The numbers are in `docs/phase-1.5-dod.md` §3.
- **Database outages.** Every request answers `DATABASE_UNAVAILABLE`, 503, with `Retry-After` and "Nothing has been lost", rather than a generic 500 (`server/src/lib/databaseErrors.js`, from error shapes measured against a stopped Postgres). A signed-in person opening the app meanwhile is told the service can't be reached and that they are still signed in, not sent to sign in; the page opens by itself when the database is back. The same drill with Postgres stopped pages once, on the platform's pager. It recovers within seconds of the database coming back.
- **A Redis outage.** Reads stay up, unmetered; analysis is refused with `SERVER_BUSY`, 503, because an unmetered analyze path spends money (FR-5.6). This holds when Redis is gone at boot too: until step 75 the API exited there, and its limiters would not have recovered once Redis returned (`server/src/lib/failurePolicyStore.js`).

## Repository layout

```
server/
  prisma/                schema.prisma and migrations (migration policy: docs/migrations.md)
  src/
    app.js, index.js     the Express app and the process bootstrap (timeouts, graceful shutdown)
    routes/              auth, documents, ops (health/ready/version)
    middleware/          auth, rate limits, CSRF, request id, upload, validation, the error handler
    services/            extraction (PDF/DOCX/paste), analysis orchestration, llm/, verify, risk
    schemas/             Zod: env, request bodies, the model's own output contract
    prompts/             the analysis prompt, versioned as code
    lib/                 AppError, error codes, pagination, serializers, graceful shutdown
  tests/                 unit, integration (against an ephemeral Postgres), fixtures
  Dockerfile
client/
  src/
    api/                 the one fetch wrapper every request goes through
    auth/                session state (in memory only — never localStorage)
    pages/, components/  screens and the shared UI primitives
    i18n/                the English/Indonesian string scaffold (English ships; see BUILD-PLAN D-B)
  e2e/                   Playwright, with axe accessibility assertions
docs/
  PRD.md, SRS.md         the specifications this repository implements
  migrations.md          the expand/contract migration procedure
  design/                the UI prototype (visual source of truth)
BUILD-PLAN.md            the sequenced steps this codebase was built from
docker-compose.yml       Postgres + Redis + the API, for local development
```

`server/tests/fixtures/` holds a synthetic contract corpus and `expected.json`, its hand-checked answer key — see the README in that directory for what each fixture exercises and why fixture 03 (a genuinely clean contract, zero findings expected) is the important one: it's the release gate that catches a model inventing problems to look useful.

## Local setup

Requires Docker and Node 24 (`server/.nvmrc` pins it exactly for the API; both `package.json`s constrain `engines.node` to `>=24 <25`, and `.npmrc` sets `engine-strict=true` so a dependency that disagrees fails the install instead of warning).

```sh
# Postgres, Redis, and the API — the API boots with LLM_PROVIDER=mock
# by default, so this works with no real Anthropic key.
docker compose up

# Migrations run as a separate, explicit step — never automatically at
# boot (SRS §5.5: with two or more instances, automatic migrations at
# startup race each other). One-time, or after a schema change:
docker compose run --rm migrate

# The frontend, in a second terminal:
cd client && npm install && npm run dev
```

The client defaults to `http://localhost:3000` for the API (`client/.env.example`); the API's default CORS origin is `http://localhost:5173`, Vite's default port — the two are already each other's counterpart in `docker-compose.yml`.

To point the stack at the real model instead of the mock provider, override `LLM_PROVIDER=anthropic` and supply a real `ANTHROPIC_API_KEY` (see `server/.env.example` for every variable and what each one is for).

Running the test suites doesn't need `docker compose up` — `server`'s integration tests start their own ephemeral Postgres via Testcontainers (just needs Docker running), and the mock LLM provider means no test ever makes a real network call to Anthropic:

```sh
cd server && npm test    # unit + integration
cd client && npm test    # unit
cd client && npm run e2e # Playwright + axe; starts its own dev server if one isn't already running
```

## Measured cost per analysis

<!-- PRD §10.1: this section must quote the MEASURED cost per analysis
     from real logged token counts (Analysis.inputTokens/outputTokens,
     recorded per row since the analyze endpoint shipped), never an
     estimate. Fill it in once the fixture corpus — or real usage — has
     run against the real provider and there are logged rows to read it
     from. -->

**USD 0.0194 per analysis**, measured over 62 analyses on the shipping configuration (`claude-sonnet-5`, prompt `analyze-v6`) at list pricing of USD 2.00 / Mtok input and USD 10.00 / Mtok output: 303,188 input and 59,406 output tokens, USD 1.2004 in all. Read from the provider's own token counts as the instrumentation recorded them (PRD §11.4), not estimated:

| Source | Analyses | Input / output tokens | USD | Per analysis |
|---|---|---|---|---|
| The real `POST /documents` + `/analyze` path: `Analysis` rows, 2026-09-21 to 24 | 5 | 31,772 / 5,426 | 0.1178 | 0.0236 |
| `scripts/benchmark.js`, fixtures 01–04 × 3, 2026-09-21 (`scripts/benchmark-history.jsonl`) | 12 | 57,279 / 9,261 | 0.2072 | 0.0173 |
| `scripts/benchmark.js`, fixtures 01–04 and 09 × 3, 2026-09-28 | 15 | 71,379 / 14,662 | 0.2894 | 0.0193 |
| `scripts/benchmark.js`, fixtures 01–04 and 09 × 3, 2026-10-06 (`c263c64`) | 15 | 71,379 / 14,762 | 0.2904 | 0.0194 |
| `scripts/benchmark.js` in CI (`benchmark.yml`, its own key), the same corpus × 3, 2026-10-12 (`20bcb6e`) | 15 | 71,379 / 15,295 | 0.2957 | 0.0197 |

Not in the total: fixture 04 alone × 12, 2026-10-06, USD 0.2008 (0.0167 an analysis). It is one mid-length document, which would tilt the mean, and it was run without a history row, so its token counts were not kept.

**Budget by length, not by the mean.** The cheapest was the clean contract (fixture 03, no findings): USD 0.0107. The dearest was a 3,886-word document near the 4,000-word cap: USD 0.0480, on **12,679 input tokens, almost twice the 6,600 that SRS §5.4 estimated** for a document at the cap. Plan on about five cents for a full-length contract. This is the gap PRD §10.1's rule exists for.

All of it is synthetic contracts during development. There has been no real usage yet; the closed beta (PRD §15) is the first real sample, and this section is to be re-measured from it.

**Why this model.** The project started on `claude-haiku-4-5` (USD 0.0111 per analysis) because BUILD-PLAN D-F says to begin at the cheapest candidate and let the benchmark promote upward. The benchmark then did exactly that. Measured over three repeats of all four fixtures per condition, Haiku derived the wrong `overallRisk` on 3.33 of 4 documents with one document flapping between runs, while Sonnet 5 scored 4 of 4 with no variation — a fault two prompt revisions had failed to fix. Sonnet is also *faster* here (10.1s mean against 13.0s), because Haiku's noisier finding lists cost more output tokens than Sonnet's reasoning costs. Raising `output_config.effort` to `high` was tested and rejected: it bought precision but broke the "fixture 03 returns exactly zero findings" gate in one run of three, made risk correctness worse, and took 40.5s on a short contract against a 60s timeout. Full numbers in `docs/phase-1-dod.md` §8.

**The accuracy gates pass, at commit `c263c64` on 2026-10-06 and again in CI at `20bcb6e` on 2026-10-12**: recall 100%, precision on the clauses the key marks fair 100%, the clean contract clean, TR-15's hostile documents never clean, per-document risk correct on all five, in every one of three repeats. They did not on 2026-09-28: with the prompt, the model and fixtures 01–04 byte-identical, **precision was 66.7% in the worst repeat** (fixture 04's fair 50%-deposit clause, flagged once), under the 85% that blocks a release. That run was not repeated until it passed. The flag was measured instead (fixture 04 alone, 12 repeats: none), and the corpus was given seven fair clauses, so one stray flag reads 85.7% rather than failing outright. Two passing three-repeat runs are still a small sample; the weekly CI run adds to it. `docs/phase-1-dod.md` §8 has all of it. Separately, 2 of 24 analyses in §8's v6 measurement needed the FR-3.2 retry because the model omitted the `summary` field; it was retried once and succeeded, and the durable fix is to constrain the response with `output_config.format` rather than to ask for it in prose.

## What I learned

<!-- PRD §11.4: the per-analysis instrumentation (duration, tokens,
     finding/discard counts, rule-vs-model risk, retry count, error
     code) exists specifically to answer this section honestly, from
     real numbers, once there's been real usage: real cost per
     analysis, real failure rate, real hallucination-catch rate (how
     often the verifier actually discards something). -->

From the instrumentation, on every analysis that has reached the real provider so far: 29 through the API path (`Analysis` rows; 16 on `claude-haiku-4-5` while the model was being chosen, 13 on `claude-sonnet-5`, 5 of them on the shipping prompt) and 69 through the benchmark. **No real user has run one yet**, so these are development numbers on synthetic contracts, with their sample sizes; the closed beta replaces them.

- **Cost:** USD 0.0194 per analysis on the shipping configuration, from USD 0.0107 for a short clean contract to USD 0.0480 near the length cap (above). Measured input tokens at the cap ran to nearly twice the specification's estimate.
- **Failure rate:** **0 of 29** analyses through the API path failed. Zero in 29 is consistent with a true rate as high as about 10% (the rule of three), so it shows the pipeline works, not that it meets PRD §11.2's "< 2% end in a user-visible error". The benchmark cannot add to it: it stops at the first failure and writes no history row, so its 69 completed analyses are survivors by construction.
- **Hallucination-catch rate:** the verifier discarded **1 of 137** findings the model reported (0.7%), in 1 of 29 analyses: the long document near the cap, where 1 of its 4 quotes was not in the contract. On the shipping configuration that is 1 of 19 through the API path, and 0 in the benchmark's 69 analyses. No discarded finding was ever shown to anyone. Whether that one quote was a paraphrase of a real clause or an invention is not recorded: only the count is, because the discarded text could be document content.

One thing these numbers needed that the instrumentation did not give them: **the `Analysis` rows' status had been overwritten.** All 29 read `FAILED / STALE_ANALYSIS`, with tokens, durations and findings intact. A mutation test of the stale-analysis reaper on 2026-09-24 (its `status: "PENDING"` condition removed, to prove a test would catch it) was picked up by a development server watching the same files, which then reaped every analysis in the development database. Each row's original outcome was recovered from what only a completed analysis has (`summary` and `overallRisk` set): all 29 had completed. The lesson is about the method, not the reaper: mutation tests now run in an isolated copy of the tree, never where a watching process can load them.

## Specifications

- [docs/PRD.md](docs/PRD.md) — product requirements, decisions, and the launch gates
- [docs/SRS.md](docs/SRS.md) — the system specification this repository implements
- [docs/migrations.md](docs/migrations.md) — the expand/contract schema-migration procedure
- [BUILD-PLAN.md](BUILD-PLAN.md) — the sequenced build steps
