# Staging and production environments: the technical reference

BUILD-PLAN step 75. This is what the configuration in the repository assumes and why; [panduan-pemilik.md](panduan-pemilik.md) is the step-by-step for the owner, who creates the accounts and holds the secrets. [deployment.md](deployment.md) is the procedure once the environments exist. Nothing here has run against the real providers yet: no account exists. What was verified, and how, is stated per piece.

## The stack

| Piece | Provider | Configured in | Verified locally |
|---|---|---|---|
| API (2 instances, 512 MB each) | Render, web service from an image | `ops/render/{staging,production}.render.yaml` | Blueprint guard tests (`renderBlueprints.test.js`); the image is the one every drill and load test ran |
| Postgres 15 | Render Postgres, paid plan (point-in-time recovery) | the same Blueprints | — |
| Redis | Render Key Value, `noeviction`, private | the same Blueprints | — |
| Deploys | GitHub Actions → Render API and Netlify API | `.github/workflows/deploy.yml`, `scripts/deploy/platform.sh` | the adapter against a fake of both APIs: success, failure, timeout, missing ids (`ciPipeline.test.js`) |
| Frontend | Netlify, a prebuilt directory per deploy | `client/scripts/staticHostHeaders.js` (`_headers`), `client/public/_redirects` | every screen of the BUILT client under the shipped CSP, zero violations (`client/e2e/csp.spec.js`) |
| Email | Resend | `EMAIL_PROVIDER=resend` (`server/src/lib/email/resendProvider.js`) | at the fetch boundary: request shape, idempotency across retries, permanent vs transient answers |
| Metrics | Grafana Alloy (a Render private service) → Grafana Cloud | `ops/monitoring/alloy/` | Alloy 1.11.0 scraped a rehearsal API instance through DNS discovery with the bearer token and remote-wrote 205 series to a Prometheus |
| Alert rules | Grafana Cloud's ruler | `ops/alerts/alerts.yml`, unchanged | promtool, 59 cases |
| Alert routing | Grafana Cloud's Alertmanager, page → PagerDuty, digest → email | `server/scripts/render-alertmanager.js` | rendered with dummy secrets and checked by amtool 0.28.1: SUCCESS |
| Errors | Sentry (optional, `SENTRY_DSN`) | step 74 | the scrubbing against the real SDK (step 74) |

SRS §8 names Render (or Railway) for the API and Netlify (or Vercel) for the frontend; the choice follows it.

## Things that must be true, and why

**One registrable domain for both.** The session cookie is `SameSite=Lax` (FR-7.7). A browser sends it on a cross-origin `fetch` only between origins of the same site. So use, for example:

- `app.example.com` and `api.example.com` for production;
- `staging.example.com` and `api.staging.example.com` for staging.

`*.netlify.app` and `*.onrender.com` are different sites, and sign-in would fail without an error anyone sees. `FRONTEND_ORIGIN` is the frontend's exact origin (CORS and FR-1.12's origin check). The client's `VITE_API_BASE_URL` (the `API_URL` variable in each GitHub environment) is the API's.

**The API is scraped per instance.** Through the load balancer, consecutive scrapes land on different instances and every `rate()` in the rules reads nonsense. Render resolves `<service>-discovery` on its private network to every running instance, and that is what Alloy queries (`SCRAPE_DISCOVERY_NAME`). Check this name in Render's documentation when creating the service. The port is the one Render gives the service (`PORT`, 10000 by default), which is why `SCRAPE_PORT` is 10000.

**One metrics backend (Grafana Cloud stack) per environment.** The rules in `alerts.yml` sum across every series they see; they have no `environment` filter. With staging and production in one stack, a staging drill would page production's on-call. Two stacks, two rule loads, two Alertmanager configurations.

**Secrets live in the platform, never in the repository.** In the Blueprints every secret is `generateValue` (Render creates it once: `JWT_SECRET`, `AUDIT_SALT`, `METRICS_TOKEN`, staging's `ALERT_DRILL_TOKEN`) or `sync: false` (the owner pastes it into Render's dashboard: the provider key, the email key, `EMAIL_FROM`, `FRONTEND_ORIGIN`, `SENTRY_DSN`). `renderBlueprints.test.js` fails on a literal secret. `AUDIT_SALT` must never be regenerated (lib/audit.js). Each environment has its own Anthropic key with its own spend limit; development's key is never reused.

**`MEMORY_LIMIT_BYTES` is the plan's real size.** `memory_high` divides by it. The Blueprints use the 512 MB "starter" plan, the size the load tests measured; change both together.

## Known gaps, in this configuration

1. **Backup verification has no source on Render.**
   - In production mode, the weekly `backup-verify` job runs whether or not `BACKUP_DIR` is set. Unset, it records `no_source_configured` and **`backup_verify_failed` pages** (step 62's deliberate choice: an unverified backup is a hope).
   - A managed database's backups are not files the API can list, so this will page from the first week.
   - What is needed: a source the job can check. For example, a daily logical backup (`pg_dump`) to an S3-compatible bucket, with the job listing that bucket.
   - That is engineering work, owed. Until it exists, the page is true: nobody has verified a backup.
2. **TR-24's mailbox.** `verify-staging` runs the signup journey, which reads the verification email. In staging that needs a mailbox a test can read (§9 of deployment.md); until one exists, that check fails, deliberately.
3. **Render and Netlify field names.** They follow their published references as of this writing, and the first Blueprint sync is where they are checked. Correct this repository if a field has changed, and the guard tests with it.

## What to run, and what proves it

**Locally, before any account exists:**

- server unit tests (Blueprints, adapter, renderer, email provider);
- `client/e2e/csp.spec.js` against `vite preview` (its header comment has the commands);
- `npm run test:alerts`.

**After the first deploy to staging, in order:**

1. `verify-staging` (smoke, the long analysis through the platform's proxy, E2E and axe).
2. A rollback by hand (deployment.md §10).
3. The provider and database outage drills, adapted: the fault is a staging-only key pointed at an endpoint that answers 529, and a database failover from Render's dashboard.
4. Step 68's alert drills through `ALERT_DRILL_TOKEN`, with the page reaching PagerDuty.
5. The restore drill from Render's point-in-time recovery, timed against the RTO.

Record each in the logs of [deployment.md](deployment.md) and [phase-1.5-dod.md](phase-1.5-dod.md).
