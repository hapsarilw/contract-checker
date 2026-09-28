# Branch protection

SRS §12.1: "no direct pushes to the default branch, required status checks, and a review on any change to `services/verify.js`, `prompts/`, migrations, or auth middleware." BUILD-PLAN step 70 makes that explicit and, for the review rule, calls out that single-maintainer scale needs "a real answer — either a second reviewer or a documented self-review exception... leaving it undecided means the rule silently does not apply." This file is that answer.

**Status: decided, not yet applied.** The settings below have never been set on GitHub, because the repository has never been pushed there (every commit so far has said so). `scripts/configure-branch-protection.sh` applies them in one command once it has been.

## No direct pushes, required status checks

Ordinary GitHub branch protection, no exception needed:

- Require a pull request before merging to `main`.
- Require the status checks in the table below to pass. Their names are the job names in `.github/workflows/ci.yml`; a job renamed there and not here (or vice versa) is exactly the drift `tests/unit/ciPipeline.test.js` checks for.
- Do not allow force pushes; do not allow deletion of the branch.

| Required check | What it is |
|---|---|
| `server-quality` | install, lint, format, typecheck, unit tests (server) |
| `client-quality` | install, lint, format, typecheck, unit tests (client) |
| `server-tests` | integration tests against ephemeral Postgres and Redis, then SRS §10.5's coverage gates (80% lines, 100% branch on `verify.js`/`risk.js`) |
| `client-build` | client build, bundle budget, LCP budget (FR-7.13) |
| `client-e2e` | Playwright + axe, mocked API (additional to §12.1's list — see ci.yml's header) |
| `docker-build` | the production image builds |
| `dependency-scan` | `npm audit`, both packages, gated on CRITICAL |
| `image-scan` | Trivy against the built image, gated on CRITICAL |
| `secret-scan` | gitleaks against the repository |
| `deploy-rehearsal` | step 71's rehearsal: the previous image on the current schema, the timeout chain behind a proxy, a rolling restart mid-analysis, the staging E2E spec against a real API |
| `openapi-contract-test` | every documented endpoint and error code reachable |
| `fixtures-verify` | SRS §11.3's fixture-generation check |

## The review rule: what GitHub can and cannot actually enforce here

The honest constraint, stated rather than papered over: **GitHub cannot require a review from a second person when the account has no second person.** Every plan available to a personal GitHub account lets a pull request's author approve their own pull request; blocking self-approval is an organization/enterprise feature this project does not have and is not paying for. So configuring "require 1 approval" on this repository, alone, produces exactly the failure mode step 70 warned about: a checkbox that LOOKS like a second reviewer and is satisfied by clicking "Approve" on one's own work, indistinguishable in the GitHub UI from a real second opinion. That is worse than no rule, because it reads as a control that doesn't exist.

**What is configured anyway, and why it is still worth configuring:** `.github/CODEOWNERS` names the four paths SRS §12.1 lists — `server/src/services/verify.js`, `server/src/prompts/`, `server/prisma/migrations/` and `schema.prisma`, `server/src/middleware/auth.js` — with `@hapsarilw` as owner, and branch protection requires a code-owner review on any pull request touching them. Two things this genuinely buys, even at one person:

1. **A pull request touching one of these paths cannot merge with a review left simply unrequested.** GitHub still requires an explicit approval to exist on the PR, even a self-approval — a PR that is merged without ever visiting the "Review changes" button is different from one where the author had to open it, read the diff as a reviewer would, and click approve. That is a real, if weaker, gate.
2. **The moment a second maintainer exists**, this configuration already routes the review request to them correctly, with zero further setup. The gap this file is honest about is a today-only gap, not a design limitation.

## The documented self-review exception

Since a second reviewer does not exist, the review rule's actual content — the thing that has to be genuinely worth something, not merely present — is this: **before approving your own pull request on one of the four CODEOWNERS paths, post a comment on the PR answering the questions below for that specific path.** Not privately verified in your head; posted, so it is a durable record on the PR itself, the same discipline this project has applied to everything else it calls "verified" (a mutation-tested guard, a walked-through runbook, a fired alert — always with the evidence recorded where someone else could check it later).

### `services/verify.js`

- Does `server/tests/unit/verify.test.js` still report 100% branch coverage after this change? (`npm run test:coverage` — the number, not "it should".)
- If a branch was added or changed, was it proven load-bearing by mutation: break it, confirm the intended test fails, restore, confirm the file is byte-identical to before? Paste the before/after.
- Does this change relax matching in any way (case-, whitespace-, or near-miss tolerance)? PRD D9 requires that to be a deliberate, data-backed decision, not a side effect — if the PR is that decision, say so explicitly; otherwise the answer here must be no.

### `prompts/`

- Has `node scripts/benchmark.js --repeats 3` been run against this prompt version, and do recall, precision, fixture 03's zero-findings result, and per-document risk correctness all still clear PRD §11.1's thresholds? Paste the numbers.
- Is the result appended to the committed benchmark history file (§10.4), so a regression later attributes to this specific change?

### `prisma/migrations/` and `schema.prisma`

- Does this migration follow SRS §5.5's expand/contract discipline — does the PREVIOUS release's code still run correctly against the schema AFTER this migration, with no deploy-order dependency between "run the migration" and "deploy the new code"?
- Was `prisma migrate deploy` (not `migrate dev`) run against a copy of production-shaped data, or at least against the CI ephemeral database, and did it apply cleanly?
- Does it touch a table `retention.js` or the DSAR erasure path reads or writes? If so, has [database-restore](runbooks/database-restore.md)'s re-erasure step been reread against the new shape?

### `middleware/auth.js`

- Does this change alter what `requireAuth` accepts, rejects, or attaches to `req.auth`/`req.user`? If so, which existing tests in `tests/integration/authMiddleware.test.js` exercise the new behavior, and were any tests added for the failure path specifically (not just the success path)?
- Could this change make `assertOwnDocument` (`lib/defensiveAssertions.js`) reachable with a mismatched subject where it wasn't before? If genuinely unsure, that uncertainty is itself the reason to add a case to `tests/integration/alertDrills.test.js` rather than reason it through.

A PR that cannot answer one of its path's questions with evidence, not intention, does not get self-approved. It gets left open, or split so the risky part is smaller and easier to answer.

## Applying this

```bash
scripts/configure-branch-protection.sh
```

Requires `gh` authenticated against the `hapsarilw/contract-checker` repository, and requires `.github/workflows/ci.yml`'s job names to already exist as status checks from at least one prior run (GitHub will not let a check be REQUIRED before it has been SEEN) — so the first run of `ci.yml` on any pull request has to happen before this script's `required_status_checks` step will take.
