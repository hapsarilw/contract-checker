# Legal surface, security disclosure, secrets and the restore drill

BUILD-PLAN step 74 (OPS-11), status on 2026-10-05. PRD §12, SRS NFR-2.13, §12.4, §12.5 and NFR-3.6 are the authority. **Nothing here is legal advice, and none of it has been reviewed by counsel**; PRD §17 requires that review before public launch.

| Done when (BUILD-PLAN step 74) | Status |
|---|---|
| Privacy policy, terms and subprocessor list live, and linked from the footer and the upload screen | **Built and linked; still drafts.** `/privacy`, `/terms` and `/subprocessors` are public, linked from a footer on every screen and from the upload screen where the file is handed over. They show **"Draft: not yet in force"** with a list of what is missing, for as long as any `[PLACEHOLDER]` remains (computed from the content, not a flag). The owner still has to supply: the operator, the contact addresses, the hosting, database, cache and email providers and their regions, Sentry's region, the governing law, the liability clause, the cross-border safeguards, and whether an Indonesian version is needed. |
| The no-training commitment verified, with the date and the term recorded | **Done.** Anthropic Commercial Terms §B, "Anthropic may not train models on Customer Content from Services." (effective 17 June 2025), verified on 2026-10-05 from the page itself, with its SHA-256: [verification.md](verification.md). The 30-day provider retention and the "global" default processing geography were verified the same way. |
| `security.txt` published | **Built**: `client/public/.well-known/security.txt` (RFC 9116) and [SECURITY.md](../../SECURITY.md), with a 72-hour acknowledgment and safe harbour. The contact is GitHub private vulnerability reporting, which **the owner must turn on** (repository Settings → Security). It is served once the frontend is deployed, and it expires on 2027-10-05; a test fails once it has. |
| The error tracker proven to scrub bodies before production use | **Done, against the real SDK.** Sentry 11 with four layers. A test runs a failing upload through the real SDK into a recording transport and requires the document's text, query string and cookie to appear nowhere: [ops/README.md](../../ops/README.md), "Error tracking". |
| A restore completed and **timed** against the 4-hour RTO | **Done locally, at the projected year-one volume: 18.6 s for provision, restore, verify and API ready, at 695 MB.** Not yet from a managed provider's backup, because none is chosen: [database-restore.md](../runbooks/database-restore.md). |
| No marketing or product string violates the UPL rule | **Done, and enforced.** `client/tests/unit/uplCopy.test.js` reads every user-facing string (client literals and JSX text, email templates, the legal pages, the README, SECURITY.md and the design prototype) and fails on PRD §12.2's phrases, or on "legal advice" that is not a denial. No violation was found. One claim was **inaccurate** rather than UPL: "Delete it any time and it is gone for good" on the upload screen, which backups make false (PRD §12.4). It was rewritten. |

## Decided on 2026-10-05

- **Jurisdiction (BUILD-PLAN D-F): Indonesia's UU PDP, the GDPR and the UK GDPR, all three.** The strictest clock governs: **72 hours** for access, correction, withdrawal and restriction, and for breach notice to users and the authority. See [verification.md](verification.md); the clocks are now in the [DSAR runbook](../runbooks/dsar-request.md) and the [runbook index](../runbooks/README.md).
- **Operator:** a placeholder, until the owner names one.
- **Security contact:** GitHub private vulnerability reporting.
- **Restore drill:** local, at a realistic size, now. The managed-provider drill is owed to staging.

## Owed by the owner, before launch

1. Fill in every `[PLACEHOLDER]` the draft notice lists, with counsel. Then have counsel review all three documents.
2. Turn on GitHub's private vulnerability reporting.
3. Decide whether to ask Anthropic for **zero data retention** (PRD §12.3: reduce provider retention "if it can be ... contractually"). It is an agreement, not a setting.
4. Decide on US-only inference (`inference_geo: "us"`, priced at 1.1x) or the current "global" default, and keep the subprocessor list in step.
5. **There is no in-product way to change an email address** (the API has `/api/v1/auth/change-email`; Settings has no screen for it). PRD §12.5 lists rectification as in-product, so the privacy policy currently says to write in, which it can honestly promise within 72 hours. Building the screen is a product decision.
6. Confirm that revoking the old development key in the Anthropic console happened (the [secret-rotation](../runbooks/secret-rotation.md) log).
7. Run the restore drill again from the managed provider's own backup once there is one, and every 6 months after (NFR-3.6).
