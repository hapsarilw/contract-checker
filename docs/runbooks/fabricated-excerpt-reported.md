# fabricated-excerpt-reported

**Severity 1.** Reached from the `unverified_excerpt_displayed` page, from a user report, or — adapted, see Part B — from the `cross_user_access` page.

## What you are seeing

One of these:

- **A page: `unverified_excerpt_displayed`.** A report was about to be served with a quoted excerpt that is not in its document, and the server refused to serve it. The user saw a generic error, not the fabricated quote. The log line carries `"alert":"unverified_excerpt_displayed"`, the `path` (`report` or `analyze`), the analysis and document ids, and how many excerpts failed — never the excerpt itself.
- **A user writes in**: "the report quotes something that isn't in my contract." That is worse than the page. If the defensive assertion was working, nothing unverified should have reached them — so either the assertion has been bypassed, or the quote is real and they are mistaken, or the quote differs from their copy of the document (a different version, an edited file).

Either way, PRD §11.1 says the number of fabricated excerpts shown to a user is **zero, structurally**. This runbook is what happens when that claim is in doubt.

## First five minutes

1. **Stop new analyses.** Set `ANALYSIS_ENABLED=false` in the platform's environment and restart (config is read at boot; a restart took two seconds in the walkthrough). Analyze then answers `503 SPEND_LIMIT_REACHED` with an honest "paused while we look into something" message, reads keep working, and **no quota is consumed** — the request is refused before an analysis row exists.
   *Why this and not the circuit breaker:* the flag is the rollback lever PRD §15 names, and it is the only switch that cannot be half-open.
2. **Open an incident record** with the time, the alert or the report verbatim, and the ids.
3. If it came from a **user report**, get their consent before looking at their document. Ask plainly: "May we open the document to reproduce this? We will look at it only for this investigation." If they say no, investigate with the ids and the logs only, and say so in the record.

## Diagnose

**A. Which analysis, and what does the database say?** (read-only)

```sql
-- the analysis and its findings, from the ids in the log line
select id, status, "promptVersion", model, "createdAt", "discardedFindings"
  from "Analysis" where id = '<analysisId>';
select id, severity, category, left("clauseExcerpt", 80) as excerpt_start, "createdAt"
  from "Finding" where "analysisId" = '<analysisId>' order by "createdAt";
```

A finding whose `createdAt` is later than its analysis's, or an analysis whose findings you cannot reconcile with `discardedFindings`, points at something other than `services/analysis.js` having written the row.

**B. Did the matcher or the normalisation change recently?**

```bash
git log --since="30 days ago" --stat -- \
  server/src/services/verify.js server/src/services/extraction.js \
  server/src/services/analysis.js server/src/lib/defensiveAssertions.js \
  server/src/routes/documents.js server/prisma/migrations
```

`verify.js` has 100% branch coverage and a lint rule against gaining a dependency, so a change there is a strong lead. `extraction.js` holds the normalisation both sides of the match depend on. A migration that copies or moves `Finding` rows is the classic way to put an excerpt next to the wrong document.

**C. Is anything writing Finding rows outside the analysis service?**

```bash
grep -rn "finding.create\|finding.createMany\|finding.update" server/src
```

As built, `services/analysis.js` writes findings and `routes/drills.js` plants one — staging only, and removed again. Anything else is the lead.

**D. With consent: reproduce.** Compare the reported quote with the stored document text using the same matcher the server uses — never by eye; the difference is often a curly quote or a non-breaking space:

```bash
cd server && node -e '
  import("./src/services/verify.js").then(({ excerptAppears }) =>
    console.log(excerptAppears(process.argv[1], require("fs").readFileSync(process.argv[2], "utf8"))))
' "<the excerpt>" /path/to/document.txt
```

## Act

1. **Add the case to the fixture corpus BEFORE shipping a fix.** That is what stops it coming back. Two places:
   - `server/tests/fixtures/expected.json` → the top-level `fabricated_excerpts` array: `{ "against": "<fixture>", "excerpt": "...", "why": "..." }`. If the user's document shape matters and they consented, add a synthetic fixture that reproduces it — never their document.
   - `server/tests/unit/verify.test.js`, under "a fabricated excerpt is discarded".
   Then `npm run fixtures:verify` and `npm run test:unit` must both fail **before** the fix and pass after. A test that passed before the fix does not cover the bug.
2. Fix, with the accuracy benchmark re-run, because SRS §5.3 requires it for any change to the matcher.
3. Re-enable: `ANALYSIS_ENABLED=true`, restart, run one analysis yourself end to end.

## Communicate

A user who was shown a fabricated quote is owed a direct, specific message: what was wrong in their report, that it has been fixed, and what they should re-check. If the analysis was used in a negotiation, say so to them plainly — this is the failure the product's whole claim rests on.

## Close

The record lists: the alert or report, the ids, the cause, the corpus entry that now covers it, the fix commit, the benchmark result, and when analysis was paused and resumed.

---

## Part B — adapted for `cross_user_access`

**What you are seeing.** A page: `cross_user_access`. A document was loaded for a session whose subject does not own it, and the server refused to serve it. The log line carries the document id, its owner's id and the session subject's id — no email addresses.

**Treat it as a potential breach until shown otherwise.** The assertion refused this request, but the query that produced the row should have made it impossible (`lib/ownership.js` filters by owner inside the statement). If one request got that far, earlier requests on the same path may have been served before the assertion existed or through a path that does not call it.

1. **Stop the path.** If the log's `requestId` leads to one route, and the fix is not immediate, set `ANALYSIS_ENABLED=false` if it is the analyze path; for a read path, the fastest safe move is a rollback to the previous image (SRS §8).
2. **Find what dropped the owner filter:**
   ```bash
   git log --since="30 days ago" -p -- server/src/lib/ownership.js server/src/routes
   grep -rn "document.findUnique\|document.findFirst" server/src
   ```
   Every load of a user's document should go through `loadOwnedDocument`. A `findUnique({ where: { id } })` on a request path is the bug.
3. **Establish exposure.** From the logs, every request to the same route since the change was deployed. Each is a question: whose document, served to whom.
4. **Legal.** A confirmed exposure of one user's contract to another is a personal-data breach under whatever regime PRD §12.1 declared. The notification clock (72 hours under GDPR) starts when you become aware. That decision is the owner's, and it is made during the incident, not after.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | The Sev-1 drill (`POST /api/v1/drills/unverified-excerpt`): a finding planted with an excerpt not in its document, read back through the ordinary report path. `ANALYSIS_ENABLED=false` and restart; the git and grep commands in Diagnose B and C; the corpus location and `npm run fixtures:verify`. | Drill answered 500 `INTERNAL`; `unverified_excerpt_displayed_total{path="report"}` went to 1; the log line carried alert, severity, path, count and requestId and no excerpt; the planted row was gone afterwards. The flag paused analysis in a 2-second restart with reads unaffected and no quota consumed. Part B's drill (`/api/v1/drills/cross-user-access`) is covered by `server/tests/integration/alertDrills.test.js`. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71).
