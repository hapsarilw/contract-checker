# secret-rotation

**Not an alert, usually.** Reached on a schedule (`JWT_SECRET` and the provider key annually), or — **Severity 1** — when a secret may have been exposed: pushed to a repository, pasted into a chat or a ticket, printed in a log, left on a laptop that is gone.

## What you are seeing

For a suspected exposure: a secret's value, or part of it, somewhere it should not be. A key in a commit, a connection string in a screenshot, a token in a support thread, a provider's "we detected your key in a public repository" email.

**Rotate first, investigate second** (SRS §12.5). An exposed secret is being used, or can be, from the moment it was exposed; the investigation can wait an hour, the rotation cannot.

## The rules for every secret

- Secrets live in the **platform's secret store** and nowhere else — not in the repository, not in `.env` files that get copied, not in the client.
- **Development and production never share a value.** A development key that leaks must not open production.
- A new value is generated **on the machine that will hold it** or in the provider's console — never sent in chat to someone who will paste it in.
- If a key has leaked, **revoke it at the source** (the provider's console) and create a new one. Removing it from where it leaked is not enough: it has been copied.

Generate a random secret:

```bash
openssl rand -hex 32
```

## Schedule

SRS §12.5's rotation schedule, for **every secret the system holds** (step 74). `server/tests/unit/secretSchedule.test.js` fails if a secret appears in `server/src/config.js` or in any workflow without a row here.

| Secret | Where it lives | Rotate | Reason |
|---|---|---|---|
| `JWT_SECRET` | platform secret store, per environment | **annually**, and at once on suspicion | Signs every session; rotating signs everyone out, which is accepted |
| `ANTHROPIC_API_KEY` | platform secret store, per environment (a different key in each) | **annually**, and at once on suspicion | Spends money and reads every document sent with it |
| `AUDIT_SALT` | platform secret store | **never** (see below) | Rotating it permanently unlinks every audit row written before |
| `METRICS_TOKEN` | platform secret store, and the scraper | annually | Guards `/metrics` |
| `SYNTHETIC_CHECK_TOKEN` | platform secret store, the monitoring provider, and GitHub environment secrets | annually | Lets the synthetic check past the auth limiter |
| `EMAIL_PROVIDER_KEY` | platform secret store | annually, per the provider | Sends as the product's domain |
| `SENTRY_DSN` | platform secret store | when abused (it is semi-public by design: it can only send events, never read them) | Someone sending junk events with it |
| `ALERT_DRILL_TOKEN` | staging's secret store only | after each drill campaign | Enables the drill routes in staging |
| `DATABASE_URL` / `REDIS_URL` credentials | platform secret store; `DATABASE_URL` also in GitHub environment secrets, for the migration job | annually, by the provider's mechanism | Reads and writes everything |
| `PLATFORM_TOKEN` | GitHub environment secrets (staging, production) | annually | Deploys |
| `SMOKE_ACCOUNT_PASSWORD` | GitHub environment secrets | annually | Signs in as the synthetic smoke account |
| `PROMETHEUS_TOKEN` | GitHub environment secrets | annually | Reads metrics for the deploy watch |
| `ANTHROPIC_BENCHMARK_KEY` | GitHub environment secrets (`benchmark`, `benchmark-pr`) | annually | The benchmark's own provider key, with its own spend limit |

**Any suspected exposure is a Severity 1: rotate first, investigate second.** The schedule is a floor, not a wait. If personal data may have been exposed with the secret, UU PDP Article 46 and GDPR Article 33 start a **72-hour** clock for telling the people affected and the authority (`docs/legal/verification.md`).

## Per secret

### `JWT_SECRET` — rotate freely; it signs everyone out

Every session cookie is signed with it. Replace it in the secret store, restart: every existing session answers **401 `UNAUTHENTICATED`** and everyone signs in again. That is the whole cost, and SRS §12.5 accepts it. Rotate annually, and at once on any suspicion.

### `AUDIT_SALT` — do NOT rotate as part of an incident

**This one is different, and it must never be part of a "rotate everything" response.**

The audit trail never stores user ids or IP addresses. It stores `hmac(value, AUDIT_SALT)`, so that events for one person can be found together without the table holding who they are. Change the salt and **every audit row written before the change can no longer be linked to anyone**. The walkthrough measured it: one user, one database, their security history in the data export went from **7 events to 0** the moment the salt changed — and came back only because the old salt still existed. After a real rotation it does not come back.

That breaks, silently and permanently:

- a user's own security history in their data export (FR-4.5);
- the investigation of any past incident ("which accounts did this IP address hit?");
- the database-restore procedure's re-erasure of accounts that a restore brought back ([database-restore](database-restore.md), step 5), which matches deletion events by this hash.

**If `AUDIT_SALT` itself is exposed:** what an attacker gains is the ability to test guesses — "is this user id or IP address the one behind this hash?" — against the audit table, which they would also need to have. It does not open any account. So the response is to protect the table, not to rotate the salt reflexively. Rotating it is a decision for the owner, taken knowingly, recorded with its reason, accepting that historical correlation ends at that moment.

### `ANTHROPIC_API_KEY` — add the new, deploy, revoke the old

1. Create a new key in the provider's console.
2. Put it in the platform's secret store in place of the old one, and deploy.
3. Confirm it works: run one analysis; `llm_request_total{outcome="success"}` increments and there is no `llm_config_error` page.
4. **Then** revoke the old key in the console. In that order, so analysis never goes down. (For a leak, revoke first and accept the minutes of `llm_config_error` — an exposed key costs money for every minute it lives.)

### `METRICS_TOKEN`

Replace it in the secret store **and** in the scraper's configuration in the same change, then restart. The old token answers 401 at once, so a scraper still holding it goes dark — which the alerts relying on it will not tell you, because they are what went dark. Check the dashboards are still moving afterwards.

### `SYNTHETIC_CHECK_TOKEN`

Replace it in the API's secret store and the monitoring provider's, together. A mismatch means the synthetic check's logins are counted by the auth limiter again and it locks itself out within minutes (`ops/README.md`).

### `EMAIL_PROVIDER_KEY`

The provider's own mechanism. While it is being changed, verification and password-reset emails fail; `email_delivery_failures` will say so. Do it when that matters least.

### `DATABASE_URL` / `REDIS_URL` credentials

The database provider's credential rotation. Most managed providers allow a second user or password alongside the first: create the new one, deploy with it, confirm `/api/ready`, then remove the old. If the provider only replaces in place, expect a short outage and plan it.

### `ALERT_DRILL_TOKEN`

Staging only. Production refuses to boot with it set at all. If one ever appears in production configuration, that is the incident, not the token's value.

## Close

Record: which secret, why (schedule or exposure), where it had leaked if it had, when it was rotated, how you confirmed the new one works, and when the old one was revoked. For an exposure, also: what the exposed secret could have been used for, and whether there is evidence it was.

---

## Rotation log

Record every rotation, scheduled or not: date, secret, environment, why, and who. The next scheduled date is a year after the last row for that secret.

| Date | Secret | Environment | Why | Notes |
|---|---|---|---|---|
| 2026-09-29 | `ANTHROPIC_API_KEY` | development | part of the key was printed into a session transcript during step 70 (never committed, never pushed) | new key installed by the owner, checked without displaying it. **Revocation of the old key in the Anthropic console is to be confirmed by the owner** |

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | `JWT_SECRET` rotated with a session open; `AUDIT_SALT` changed with an account holding audit history, then changed back; `METRICS_TOKEN` rotated. | JWT: the old cookie answered 200 before and 401 `UNAUTHENTICATED` after; a fresh sign-in worked. AUDIT_SALT: the same account's data export listed **7** security events before the change and **0** after, in the same database, and 7 again only once the old salt was restored. METRICS_TOKEN: the old token answered 401, the new one 200. The provider-key, email-key and database-credential rotations need real provider accounts and were not exercised. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71).
