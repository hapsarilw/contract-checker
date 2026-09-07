# ClauseCheck

Freelancers sign contracts they don't fully read. The clauses that cause the most damage are boring to read and easy to skim past: unlimited revisions, net-60 payment terms, full IP assignment on work made before the contract started, termination-for-convenience with no kill fee. A lawyer review costs $150–500 per contract, which is economically irrational under about $5k of project value — so most freelancers just sign, and find out what they agreed to when the client invokes it. ClauseCheck is the structured, verifiable middle: a fast first pass that flags the handful of clauses worth a second look. Every finding quotes the contract verbatim and is checked against the source text before it is shown, so the user can confirm nothing was invented. That verifiability claim is the product.

**Status: in development.**

## Repository layout

```
.github/workflows/       CI, deploy, benchmark, and scan pipelines
server/
  prisma/                schema.prisma and migrations
  src/
    routes/              auth, documents, account, ops
    middleware/          auth, rate limits, request id, error handler
    services/            extraction, analysis, llm, verify, risk, quota, email, audit
    jobs/                retention, reaper
    observability/       logger, metrics, tracing
    schemas/             zod: env, requests, AnalysisResult
    prompts/             the analysis prompt as versioned code
    workers/             worker-thread document extraction
    lib/                 shared helpers
  tests/                 unit, integration, e2e, load, fixtures
client/src/              pages, components, API client
docs/
  PRD.md  SRS.md         the specifications every build step cites
  design/                the UI prototype and visual source of truth
  runbooks/              on-call procedures
scripts/                 benchmark and restore-drill tooling
```

`server/src/services/verify.js` is the excerpt verifier described in SRS §5.3 — the control that makes the verifiability claim true. It has its own README section in the SRS and its own coverage gate.

## Test fixtures

`server/tests/fixtures/` holds a synthetic contract corpus and `expected.json`, its answer key. Every excerpt in the key was checked against the shipped documents using the exact matcher from SRS §5.3. See the README in that directory for what each fixture exercises and why fixture 03 — the clean contract — is the important one.

## Cost per analysis

<!-- PRD §10.1 requires this section to quote the MEASURED cost per analysis from
     logged token counts, never an estimate. Fill it in once §11 instrumentation
     is reporting real numbers. -->

Not yet measured.

## Specifications

- [docs/PRD.md](docs/PRD.md) — product requirements, decisions, and the launch gates
- [docs/SRS.md](docs/SRS.md) — the system specification this repository implements
- [BUILD-PLAN.md](BUILD-PLAN.md) — the sequenced build steps
