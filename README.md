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
- **The API is stateless across instances.** Nothing may live in process memory that a later request depends on. This is why the one-PENDING-analysis-per-document guard is a database constraint (a partial unique index), not an in-memory lock — a lock only stops a race on the instance that holds it — and it's why the rate limiters' in-memory store (`server/src/middleware/rateLimits.js`) is explicitly marked as correct for exactly one instance and wrong the moment a second one joins the fleet, with the Redis-backed replacement left as a one-line change rather than a redesign.

## The excerpt-verification defense

This is the part of the project actually worth reading, because it's the answer to the obvious objection: **an LLM will confidently invent a quote that sounds exactly like it belongs in the contract, and a user has no way to tell a real clause from a fabricated one just by reading the report.** A "finding" that quotes text the contract doesn't contain isn't a minor bug — it's the product lying to someone about a document they're about to sign, in the specific way a "trustworthy first pass" is supposed to prevent.

So nothing the model says ships as-is. Every finding's `clause_excerpt` is checked against the actual, stored document text (`server/src/services/verify.js`) before it ever reaches a response. The match is **case-insensitive, whitespace-collapsed, and tolerant of curly-vs-straight quotes** — a real clause reflowed or retyped by the model still matches — but it is a **strict substring match, never a fuzzy one.** PRD decision D9 states this outright: no near-miss tolerance, ever, because near-miss tolerance is exactly the hole a paraphrasing model would slip through. A model that rephrases a real clause "close enough" to sound plausible is indistinguishable, under fuzzy matching, from a model that invents one from nothing — the whole point of verification collapses the moment the matcher gets forgiving. Strict matching costs something measurable: an occasional legitimate finding gets discarded because the model lightly reworded it. That cost is tracked (`discardedFindings`, the `analysis_findings_discarded_total` metric) and is the thing to revisit with real data, not intuition, if it turns out to be too high (PRD §11.1's guardrail: over 10% discarded over 7 days).

The failure mode this closes isn't hypothetical, and it's asymmetric with how it fails: if the model reports findings and **all of them** fail verification, the analysis does **not** quietly become a clean report — it fails outright (`FAILED`, `ALL_FINDINGS_DISCARDED`, 502). An analysis that hallucinated everything must never look, from the user's side, identical to a contract that's actually fine.

## Failure handling

Every failure mode below returns the same `{ error: { code, message, requestId } }` shape (SRS §4) and states what to do next, not only what failed.

- **Malformed model JSON.** The response is parsed and validated against a Zod schema (`server/src/schemas/analysisResult.js`). On failure, the request is retried **exactly once**, with a correction message that quotes the specific validation error back to the model. A second failure gives up cleanly: `FAILED`, `LLM_INVALID_OUTPUT`, 502 — never a retry loop, never a raw parser exception reaching the client.
- **Every excerpt discarded.** Covered above — `FAILED`, `ALL_FINDINGS_DISCARDED`, 502, distinct from a genuinely clean contract (an empty `findings` array is a legitimate, successful result).
- **A scanned, image-only PDF.** `pdf-parse` returns little or no text from a rasterized page, which trips the 200-word floor (FR-2.5) the same way an accidentally-empty paste would — `DOCUMENT_TOO_SHORT`, 422, with a message that names a scan specifically, since it's the most common real-world intake failure, rather than a generic "too short" message that leaves a user staring at a file they know isn't short. Exercised directly by fixture 06 (`server/tests/fixtures/`).
- **Provider outages.** Specified (FR-3.10: retry transient failures with backoff and jitter; FR-3.12: a circuit breaker; `LLM_UNAVAILABLE`, 503, with `Retry-After`) but **not yet implemented** — it's Phase 1.5 work. Today, a provider outage surfaces only as a generic 500. A request that simply times out at 60 seconds (`LLM_TIMEOUT`, 504) already works correctly; a sustained outage across many requests does not yet degrade gracefully.

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

Requires Docker and Node 20 (`server/.nvmrc` pins it exactly for the API; both `package.json`s constrain `engines.node` to `>=20 <21`).

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

Not yet measured. No analysis has been run against the real Anthropic API yet — only the mock provider, in tests, which records fixed placeholder token counts rather than real ones.

## What I learned

<!-- PRD §11.4: the per-analysis instrumentation (duration, tokens,
     finding/discard counts, rule-vs-model risk, retry count, error
     code) exists specifically to answer this section honestly, from
     real numbers, once there's been real usage: real cost per
     analysis, real failure rate, real hallucination-catch rate (how
     often the verifier actually discards something). -->

Not yet — there's no real usage to learn from. This section gets filled in once real traffic (or at least a real run of the fixture corpus against the real provider) gives the instrumentation something to report.

## Specifications

- [docs/PRD.md](docs/PRD.md) — product requirements, decisions, and the launch gates
- [docs/SRS.md](docs/SRS.md) — the system specification this repository implements
- [docs/migrations.md](docs/migrations.md) — the expand/contract schema-migration procedure
- [BUILD-PLAN.md](BUILD-PLAN.md) — the sequenced build steps
