# discard-rate-high

**Severity 3, digest.** Reached from `discard_rate_high`: over the last 7 days, more than 10% of the findings the model reported were discarded by excerpt verification.

## What you are seeing

Nothing a user would notice directly, which is the point of watching it. A discarded finding is one whose quote the server could not find, word for word, in the document (§5.3), so it was dropped before anyone saw it. Users see fewer findings than the model produced — and, at the extreme, `ALL_FINDINGS_DISCARDED` failures.

PRD §11.1: target under 5%; over 10% for a week triggers **a review of §5.3's strictness**. Not a loosening. PRD D9 is explicit that the matcher stays strict — "near-miss tolerance is exactly the hole a paraphrasing model slips through" — and that the cost of strictness is measured and revisited *with data*. This runbook is how the data is gathered.

## First five minutes

Is it real, or a quiet week? The ratio has no minimum volume (`docs/alert-drills.md` §6):

```sql
select count(*) as analyses,
       sum("discardedFindings") as discarded,
       (select count(*) from "Finding" f join "Analysis" a2 on a2.id = f."analysisId"
         where a2."createdAt" > now() - interval '7 days') as shown
  from "Analysis"
  where status in ('COMPLETED', 'FAILED') and "createdAt" > now() - interval '7 days';
```

`discarded / (discarded + shown)` is the rate the alert computes.

A handful of analyses with one bad one can cross 10%.

## Diagnose

**When did it start, and with what?**

```sql
select date_trunc('day', "createdAt") as day, "promptVersion", model,
       count(*) as analyses, sum("discardedFindings") as discarded
  from "Analysis"
  where "createdAt" > now() - interval '21 days' and status in ('COMPLETED', 'FAILED')
  group by 1, 2, 3 order by 1;
```

- **It rose with a new `promptVersion` or `model`**: the change made the model paraphrase more. That change should not have shipped without the benchmark — PRD §11.1 makes the benchmark a release gate for exactly this — so check whether it ran, and run it now: `node scripts/benchmark.js --repeats 3`.
- **It rose with no change of ours**: the provider changed the model behind the same identifier, or the documents changed (more scanned-then-OCRed PDFs, whose text has errors a quote will not match).
- **It is concentrated in a few documents**: document-shaped. Extraction produced text the model then "corrected" when quoting — ligatures, hyphenation at line breaks, curly versus straight quotes that normalisation should already fold.

## Act

- A prompt or model change: roll it back if the benchmark confirms the regression.
- Document-shaped: if a specific normalisation gap is found (a character the matcher should fold and does not), that is a change to `verify.js` / normalisation, which needs the benchmark re-run and **a corpus case first** — see [fabricated-excerpt-reported](fabricated-excerpt-reported.md), "Act", for the order. Folding more characters is not loosening the matcher; accepting near-misses is.
- Do **not** lower the threshold to make the digest go away.

## Close

Record: the rate, the window, the cause, the benchmark result, and any change made.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | The SQL above over the rehearsal's analyses; the discard counter on `/metrics`. | Nine completed analyses, zero discarded — the mock provider quotes its fixtures exactly, so a high rate cannot be produced without the real model. The queries and column names were confirmed. The rule is covered, both sides of its threshold, by `ops/alerts/tests/quality.yml`. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71). A meaningful walkthrough needs a week of the real model's output.
