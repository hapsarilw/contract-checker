# risk-drift-high

**Severity 3, digest.** Reached from `risk_drift_high`: over the last 7 days, the server's rule-derived overall risk and the model's own claim disagreed on more than 25% of completed analyses.

## What you are seeing

Nothing a user sees. Users are shown the **rule's** risk, always (FR-3.9, PRD D7): high if any verified finding is high, and so on down. The model's own opinion is stored only to measure this disagreement, and never displayed.

PRD §11.1: tracked, no target; above 25% it **prompts a rule review**. The question is whether the rule is still the right summary of the findings — not whether to start showing the model's opinion.

## Diagnose

**Which way do they disagree?** On the quality dashboard: "Drift, by pair". Or:

```sql
select "overallRisk" as rule, "modelRisk" as model, count(*)
  from "Analysis"
  where status = 'COMPLETED' and "createdAt" > now() - interval '7 days'
  group by 1, 2 order by 3 desc;
```

- **Model says higher than the rule** (rule `LOW`, model `MEDIUM`): the model is weighing something the rule does not count. The most common is *missing* protections: the rule looks only at findings, and a contract with no bad clauses but no protections either comes out `LOW`. PRD §19 already lists "should missing protections influence overall risk?" as an open question waiting for exactly this data.
- **Model says lower** (rule `HIGH`, model `MEDIUM`): one high-severity finding makes the whole contract high under the rule. If the model disagrees often, look at which categories those single high findings are in.
- **It rose with a prompt or model change**: the change shifted the model's calibration. Not a problem with the rule, and not visible to users — but check the benchmark's per-document risk result for the same change.

## Act

A rule change is a product decision, recorded in the PRD's decisions log, with the benchmark's risk-correctness result before and after. Not an operational fix. Record what the data showed and put it in front of whoever owns that decision.

## Close

Record: the ratio, the dominant pair, and what it suggests about the rule.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | The SQL above over the rehearsal's analyses. | **9 of 9 completed analyses drifted**: the mock provider always claims `medium`, and with no findings the rule says `LOW`. An artefact of the mock — but a live example of the first pattern above (a contract with no findings, which the model still rates as risky), and a reminder that this alert would fire at once on a model that does the same. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71).
