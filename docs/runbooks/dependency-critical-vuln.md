# dependency-critical-vuln

**Severity 3, digest.** Reached from `dependency_critical_vuln`: a dependency or container-image scan found a known-exploitable critical vulnerability (raised by CI: `.github/workflows/scan.yml` weekly, and `ci.yml`'s `dependency-scan` and `image-scan` on every pull request).

## What you are seeing

A failed scan: on a pull request, the check blocks the merge; on the weekly scan of the default branch, a digest naming a package, an advisory and a severity.

The policy is SRS §2.1's: **a known-exploitable critical in a runtime dependency is patched within 7 days, or the dependency is removed.** The clock starts at the digest.

## Where the alert actually comes from today

Two sources, both GitHub Actions: a pull request's `dependency-scan` (npm audit, critical) or `image-scan` (Trivy, critical **and fixed**) check failing, which blocks that pull request; and the weekly `scan.yml`, which is the one that matters for a repository nobody is touching, and which — unlike the pull-request gate — also fails on a critical that has **no fix yet**. A failed workflow reaches you as GitHub's own failed-run email. It is not yet routed into the Alertmanager digest (`ops/alerts/ci-alerts.yml` declares the alert; nothing posts it), so until that is decided, the email is the alert.

## First five minutes

**See the same thing the scanner saw:**

```bash
cd server && npm audit
cd client && npm audit
cd server && npm audit --omit=dev     # only what production installs
```

## Diagnose: three questions, in order

**1. Is it in something production runs?** `--omit=dev` answers "installed in production", not "loaded at runtime". They differ here: the `prisma` CLI is a production dependency (migrations run from it at release), so its whole tree — including `mysql2`, which this application never loads — counts as production. Find why a package is there:

```bash
cd server && npm ls <package>
```

A package that arrives only through a build or migration tool is real but not reachable from a request.

**2. Is it reachable from input an attacker controls?** Two dependencies are the highest risk in the tree, because parsing untrusted input is their whole job: **`pdf-parse`** and **`mammoth`**, which open every uploaded file. A critical in either is an escalation — assume it is reachable, because an upload is exactly the input it takes. They run in a worker thread with a 10-second limit (FR-2.11), which contains a hang, not a code-execution bug. Next after them: `express` and its body parsers (`body-parser`, `qs`), which see every request.

**3. Is a fixed version available?** `npm audit` says. A fix outside the currently pinned range needs a deliberate upgrade with the test suite and, for anything on the analysis path, the benchmark.

## Act

- **Fixed version exists**: upgrade, run `npm run verify`, ship within the 7 days.
- **No fix, and it is `pdf-parse` or `mammoth`**: the options are to disable the affected intake (upload that format off; paste still works) or to replace the library. Decide within the 7 days, not at the end of them.
- **No fix, and not reachable from input** (a CLI's transitive dependency): record why it is not reachable, and re-check at each weekly scan.

## Close

Record: the package, the advisory, whether it was reachable and why, what was done, and the date — against the 7-day window.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | this repository | `npm audit` for server and client, and `--omit=dev` for the server; the reachability questions applied to what it found. | Client: 0. Server: **0 critical**, so the alert's condition is not met — but 4 high and 3 moderate, all present before this step. Applying question 1: the high ones (`prisma`, `@prisma/config`, `deepmerge-ts`, `mysql2`) come through the migration CLI and are not loaded by the running API. Applying question 2: the moderate ones (`qs`, `body-parser`, `express`) sit in the request path — not critical, so not this policy, but the first thing to patch in routine maintenance. The scanner that raises this alert is written (step 70) but has not run on GitHub yet. |

**Staging walkthrough: not applicable** — this runbook acts on the repository, not on an environment. What is still owed is a real failed run of the scanner reaching whoever reads the digest.
