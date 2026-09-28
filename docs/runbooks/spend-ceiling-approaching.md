# spend-ceiling-approaching

Reached from **`spend_ceiling_80`** (Sev 3, digest: spend has reached 80% of the monthly ceiling) or **`spend_ceiling_100`** (Sev 2, page: the ceiling is reached).

## What you are seeing

At 80%: nothing, from the user's side. A digest says four fifths of the month's provider budget is spent.

At 100%: users cannot run a check. Analyze answers **503 `SPEND_LIMIT_REACHED`** ("Analysis is temporarily unavailable while we're above our monthly usage limit"), the upload screen shows the degraded-mode banner, and everything else — reports, history, login, deletion — keeps working (PRD D13). It stays that way until the ceiling is raised or the month turns over.

## First five minutes

**How close, and how fast?** On the quality dashboard: "Spend against ceiling" and "Spend this month". Or:

```promql
max(llm_spend_usd_month) / max(llm_spend_ceiling_usd)
```

Then the question that decides everything else: **is this ordinary growth, or one account?**

## Diagnose

```bash
cd server && npm run ops -- spend-by-account
```

prints this month's estimated spend per account, most expensive first, with each account's share of the total, its analysis count, how many of those failed, its email, its state and its id:

```
period 2026-09: 3 account(s), $0.0262 recorded on analysis rows
    $0.0187   71.4%     5 analyses (0 failed)  heavy@example.com  ACTIVE  cmul5554d…
```

How to read it:

- **One account holds most of the spend**, especially one that is new, has many failures, or is running far beyond an ordinary freelancer's month (the per-user monthly quota, FR-5.1, bounds a legitimate account): abuse, a scripted client, or a stolen login. Consider suspension, below.
- **Spend is spread across many accounts**: this is growth. The ceiling was set for less traffic than you now have. Consider raising it.
- **The meter is well above the total on the analysis rows**: the meter (`llm_spend_usd_month`, from Redis) counts every analysis this month, including those of accounts deleted since — their rows went with them. A large gap means heavy spend by accounts that no longer exist, which is itself worth a look in the audit trail (`ACCOUNT_DELETED` events this month).

## Act

**Raise the ceiling** — the growth case. `MONTHLY_SPEND_CEILING_USD` in the platform environment, then restart. This is a money decision and the owner's to make; the unit economics are PRD §10. At 100% it lifts degraded mode on the next request.

**Suspend an account** — the abuse case:

```bash
cd server && npm run ops -- suspend --email <address> --reference <ticket or incident id>
```

The account's very next request answers 403 `ACCOUNT_SUSPENDED`; no session needs revoking, because the server reads the state on every request. It is recorded as `OPERATOR_SUSPENDED` in the audit trail with your reference. Note: a suspended account can still *sign in* — the sign-in answers 200 — but every request after it is refused, so the interface shows an error rather than a clear "suspended" screen. If you suspend a real person, tell them directly.

To lift it, when the matter is resolved:

```bash
cd server && npm run ops -- lift-suspension --email <address> --reference <same reference>
```

It restores `ACTIVE` only if the account had verified its address, and `UNVERIFIED` otherwise, so a suspension cannot be used to skip verification.

**Do neither** if the month turns over within a day or two and the spend is legitimate: the counters roll by construction on the 1st (UTC).

## Communicate

At 100% on the status page: "Checking new contracts is paused until <date> while we are above our usage limit for the month. Your saved reports are unaffected."

## Close

Record: the percentage when you arrived, the per-account breakdown, the decision (raise, suspend, wait) and why, and the new ceiling if changed.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | Spend pushed to 84% of a $50 ceiling in the meter; `npm run ops -- spend-by-account` with three accounts; `suspend` without a reference (refused), with one; the suspended account's sign-in and next request; `lift-suspension`; the audit rows. | The metric read `llm_spend_usd_month 42.00`, `llm_spend_ceiling_usd 50`. The report ranked the heavy account first at 71%. Suspension without `--reference` exited 1 and changed nothing; with it, the next request answered 403 `ACCOUNT_SUSPENDED`; after lifting, 200. Audit trail: `OPERATOR_SUSPENDED` and `OPERATOR_SUSPENSION_LIFTED`, both carrying the reference. **Fixed during the walkthrough:** the report printed one analysis's cost as `$0.00`, which would point an operator away from the account doing it; it now shows four decimals under a dollar. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71).
