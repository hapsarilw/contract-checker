# email-delivery-failures

**Severity 3, digest.** Reached from `email_delivery_failures`: more than 10% of emails failed to send over the last hour.

## What you are seeing

New users who never received their verification link, and people who asked to reset a password and heard nothing. Support messages saying "I didn't get the email." Nothing on any dashboard is red except this: no request fails, because every email is queued and sent in the background (NFR-3.8), so a failed send never turns into an error page.

That is why it matters more than its severity suggests: **a new account cannot run a check until its address is verified** (FR-1.7). Verification email failing is a signup outage.

## First five minutes

**Which messages?**

```promql
sum by (type, outcome) (increase(email_send_total[1h]))
```

`type` is one of `verification`, `email_change_verification`, `password_reset`, `password_changed`, `email_changed` and `account_deleted` (`server/src/lib/email/templates.js`). Failures in one type only: the template or the data for that type. Failures across all: the provider.

**What did the provider say?** Search the logs for `"alert":"email_send_failed"`. Two messages carry it:

- `"email delivery failed and will not be retried"` — the provider refused all 3 attempts (10-second timeout each); `err` says what it answered.
- `"email could not be built"` — the message never reached the provider: a template failed for that type.

`"email delivery failed, will retry"` at warn level is an attempt that may still succeed.

## Diagnose

- **All types failing, provider errors 401/403**: the provider key — [secret-rotation](secret-rotation.md), `EMAIL_PROVIDER_KEY`.
- **All types failing, timeouts**: the provider is down or unreachable. Its status page.
- **Rejected as the sender**: the sending domain's SPF, DKIM or DMARC (SRS §8). Something changed in DNS.
- **One type failing**: a template error — look for `"email could not be built"`. The logs name the type; the templates are `server/src/lib/email/templates.js`.
- **Sends succeed but users say nothing arrives**: not this alert — this alert counts what the provider refused. Deliverability (spam folders) shows up as PRD §11.2's "verification email → verified" rate falling below 70% within 24 h.

## Act

Fix the cause. Then: the emails that failed are **not** retried after their three attempts. Users who asked for a verification link or a password reset during the outage have to ask again — the "Send the link again" button on the upload page, and "Forgot your password?" on sign-in, both do it.

## Communicate

If signups are affected: "Verification emails are delayed. If you signed up in the last <n> hours and did not receive one, use 'Send the link again'."

## Close

Record: which types, how long, the cause, and how many users were affected (the count of failed sends by type).

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | Real sends through the development mail sink (verification, account deletion); `email_send_total` read after a restart. | The sink wrote each message as a file; the deletion confirmation carried its subject and the 30-day backup sentence. `email_send_total` has **no series at all** after a restart until the first send — which is why the alert's ratio has no data rather than 0% in a quiet hour, as the promtool test "an hour with no email at all is not a failure" expects. A provider failure could not be produced: only the sink exists, and no real provider has been chosen. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71), and no email provider has been chosen, so there is nothing yet for sends to fail against.
