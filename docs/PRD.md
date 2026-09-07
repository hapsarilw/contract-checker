# Product Requirements Document
## ClauseCheck — Contract Red-Flag Checker for Freelancers

**Version:** 3.0
**Status:** Production readiness defined. Phase 1 scope locked; Phase 1.5 (hardening) is now a gate, not a nice-to-have.
**Owner:** [product owner — name, email]
**Engineering owner:** [name, email]
**Reviewers:** engineering, security, legal counsel (external, for §12)
**Review cadence:** reviewed at each phase gate; §12 reviewed before any public launch and annually thereafter
**Last updated:** 6 September 2026

**Changes from v2.1:** this version closes the gap between "a specified project" and "a product that can be operated in front of real users with real confidential documents." Added: document control and approval (§0), business model and unit economics (§10), the complete account lifecycle including verification, reset, and account deletion (§8.1), legal, privacy and compliance posture (§12), accessibility commitment (§13), support, SLOs and incident response (§14), launch and rollout plan (§15), abuse and trust-and-safety policy (§16), and numeric targets with guardrail metrics on every success measure (§11). Rewrote §9 (scope) to introduce Phase 1.5 as a required gate between "it works" and "real users can use it." Extended the risk register (§17) with legal, provider-dependency, cost, and abuse risks. Extended the decisions log with D4–D14 (§18).

**Changes from v2.0:** rewrote the accuracy metric so it is measurable — names the fixture corpus (SRS §11) as its source, adds precision alongside recall, and explains why the corpus is synthetic.

**Changes from v1.0:** added alternatives analysis, persona, end-to-end user flow, acceptance criteria on core stories, risk derivation rule and disclaimer wording, expanded definition of done, instrumentation list, and a decisions log resolving the three original open questions.

---

## 0. Document control

| | |
|---|---|
| **Authority** | This document defines *what* ClauseCheck does and why. The SRS (v3.0) defines *how*. Where the two disagree, this document wins on product intent and the SRS wins on mechanism; the conflict is a bug in one of them and gets fixed rather than tolerated. |
| **Change process** | Material changes — scope, a decision in §18, anything in §12 — require the owner plus the engineering owner. Changes to §12 additionally require legal review. Editorial changes need no approval. |
| **Traceability** | Every functional requirement in the SRS traces to a user story in §6 or a policy in §12/§14/§16. A requirement tracing to nothing is either scope creep or a missing product decision; either way it is raised, not silently implemented. |
| **Status vocabulary** | *Locked* — will not change without the change process. *Committed* — in scope, details may move. *Deferred* — explicitly not now, with a named phase. *Rejected* — decided against, with rationale in §18. |

---

## 1. Problem

Freelancers sign contracts they don't fully read. The clauses that cause the most damage are boring to read and easy to skim past: unlimited revisions, net-60 payment terms, full IP assignment on work made before the contract started, termination-for-convenience with no kill fee.

A lawyer review costs $150–500 per contract. For a $2,000 project that math doesn't work, so most freelancers just sign. They find out what they agreed to when the client invokes it.

What's missing is a fast, cheap first pass — not legal advice, but a "here are the six things you should look at again before signing."

### 1.1 What people do instead, and why it isn't enough

| Alternative | Why it falls short |
|---|---|
| Sign without reading | The default. Risk discovered only when the client invokes a clause. |
| Ask a lawyer | Correct answer for big contracts; economically irrational under ~$5k project value. |
| Paste into a general chatbot | No verbatim-quote guarantee (hallucinated clauses), no structure, no history, and the freelancer pastes a confidential document into a general-purpose tool with no promises about what happens to it. |
| Google each clause | Requires knowing which clauses to worry about — which is exactly the missing skill. |

ClauseCheck's position: the structured, verifiable middle. Every finding quotes the contract verbatim and is checked against the source text before it's shown, so the user can confirm nothing was invented.

The verifiability claim is the product. It is also the thing that must never quietly stop being true — which is why §11 measures it directly and §14 alerts on it.

## 2. Target user

**Primary:** Solo freelancers and small studios — designers, developers, writers, videographers — who receive client contracts as PDF or DOCX and have no in-house legal support. Comfortable with software, not comfortable with legal language.

**Secondary:** Junior agency account managers doing a sanity check before passing a contract up the chain.

**Not the user:** Enterprise legal teams, anyone needing jurisdiction-specific legal advice, anyone negotiating contracts over ~$100k where a real lawyer is obviously worth it.

### 2.1 Persona

Maya, 29, freelance brand designer, three years in. A new client — her biggest yet — emails a 6-page PDF titled *Independent Contractor Agreement* and asks her to "sign by Friday so we can kick off Monday." She opens it on her phone, reads the first page, skims the rest, and feels vaguely uneasy about a paragraph mentioning "perpetual, irrevocable assignment." She doesn't know if that's normal. She doesn't have a lawyer and doesn't want to look difficult by stalling. She has maybe ten minutes and a strong incentive to just sign.

ClauseCheck exists for that ten minutes.

### 2.2 What the persona implies for production

Maya is on a phone, on cellular, under time pressure, uploading a document she is contractually forbidden from sharing. Three consequences that are easy to miss when specifying from a desk:

- **Mobile is the primary surface for first use**, not an afterthought. §13 and SRS §7 treat it that way.
- **The confidentiality promise is load-bearing.** She is often under an NDA that predates the contract she is checking. A vague privacy story is not a marketing weakness, it is a reason she cannot legally use the product. §12 exists because of this sentence.
- **She will not read documentation.** Every error must be self-explaining in the moment, and every destructive action must be unmistakable before it happens.

## 3. Goals

| Goal | Measure | Target |
|---|---|---|
| Surface real risk fast | p95 analysis wall-clock, at the word cap | < 45 s |
| Make findings actionable | Findings carrying a plain-language explanation and a sendable suggested change | 100% (schema-enforced) |
| Build trust through transparency | Displayed findings whose excerpt is verified present in the source | 100% (pipeline-enforced, §11) |
| Keep the tool honest | Reports rendering the disclaimer in body text | 100% |
| Be safe to use with confidential documents | Named subprocessors, no-training commitment, working deletion, published retention window | All four true before public launch (§12) |
| Stay up | Monthly availability of the analyze path | ≥ 99.5% (§14) |

## 4. Non-goals

Stating these explicitly, because each one is a trap that turns a shippable project into an abandoned one.

- **Not** giving legal advice or jurisdiction-specific interpretation.
- **Not** editing or redlining the document. Read-only analysis.
- **Not** a chat interface. One document in, one structured report out. No follow-up questions to the model.
- **Not** contract generation or templates.
- **Not** multi-user collaboration, comments, or sharing.
- **Not** e-signature integration.
- **Not** a general document analyzer. Contracts only; the model is told to say so when given something else.
- **Not** a system of record. ClauseCheck is not where a freelancer's contracts live; it is where they get checked. This is why hard delete is safe to offer and why there is no backup-driven undelete (§12.4).
- **Not** available to users under 18, and not offered to enterprise buyers requiring SOC 2 or a signed BAA in Phase 1 (§12.6).

## 5. User flow (Phase 1, happy path)

1. **Land** on the upload screen. One sentence explains what the tool does, how long documents are kept, and that they can be permanently deleted.
2. **Sign up** with email and password, then **confirm the email address** from a link sent to it. Unverified accounts can sign in but cannot analyze (§8.1).
3. **Provide the contract**: drag a PDF/DOCX onto the drop zone, or switch to the paste tab and paste text. Client-side checks catch oversized files immediately.
4. **Submit.** The document uploads, then analysis starts automatically. The analyzing screen shows staged progress and sets the expectation of ~30 seconds.
5. **Read the report**: overall risk first, then the summary, then findings ordered by severity, then missing protections, with the disclaimer visible without scrolling past the fold on desktop.
6. **Act on a finding**: each suggested change has a copy button, so the user can paste it into their reply to the client.
7. **Return later**: history lists past contracts, paginated; opening one shows its report again.
8. **Delete** any contract permanently from the report or history view, with a confirmation that states it cannot be undone.
9. **Leave**: delete the whole account from settings, which removes every document, analysis, and finding, and the account itself (§8.1, §12.5).

Unhappy paths — scanned PDF, oversized file, over-length document, encrypted PDF, model failure, provider outage, rate limit, spend ceiling — each end in an error that names the problem and the next step. These are enumerated in SRS §4.2.

## 6. User stories

**Onboarding and account**
- As a new user, I can create an account with email and password so my contract history is private to me.
  - *Accepts:* the password rules are stated before submission, not after rejection.
- As a new user, I receive a verification email and my account is confirmed when I follow it, so someone else cannot register with my address.
  - *Accepts:* an unverified account cannot start an analysis, and the reason given says how to fix it and how to resend.
- As a user who forgot my password, I can reset it from a link sent to my email.
  - *Accepts:* the reset link is single-use, expires within an hour, and using it signs out every other session.
- As a returning user, I can log in and see every contract I've analyzed before.
- As a user, I can sign out of all devices, so a lost laptop is recoverable.
- As a user, I can delete my account and everything in it.
  - *Accepts:* after deletion, logging in with those credentials fails, and no document, analysis, or finding belonging to that user remains in the database.

**Core loop**
- As a freelancer, I can upload a PDF or DOCX contract, or paste text directly, so I don't have to convert files myself.
  - *Accepts:* a 5 MB, 8-page text-layer PDF succeeds; a 6 MB file is rejected with a clear message before any analysis runs.
- As a freelancer, I can see an overall risk level immediately so I know whether to worry before reading details.
  - *Accepts:* risk is visible without scrolling on a 375 px-wide phone.
- As a freelancer, I can see each flagged clause with the original wording quoted, so I can verify the tool didn't invent it.
  - *Accepts:* searching the quoted text in my original document finds it (allowing whitespace/case differences).
- As a freelancer, I can see what's *missing* from the contract — no late-payment penalty, no kill fee — because absent protections are as costly as bad clauses.
- As a freelancer, I can copy a suggested rewrite for each finding so I have something concrete to send back to the client.
  - *Accepts:* one tap/click copies the suggested change; the interface confirms it; the control is reachable and operable by keyboard alone.
- As a freelancer using a screen reader, I can read the whole report, because severity is conveyed in text and not by color alone (§13).

**Management**
- As a user, I can delete a contract and its analysis permanently, because these documents are confidential.
  - *Accepts:* after deletion, the document and all findings are gone from the database, not flagged hidden; backups age out within the published window (§12.4).
- As a user, I can see when each analysis was run, in my own timezone.
- As a user with many contracts, I can page through my history without the list slowing down.

**Operator stories** — these have users too, and omitting them is how a working build becomes an unoperable one.
- As an on-call engineer, I can tell within one minute whether analyses are failing, and whether the cause is the provider, the database, or our own code.
- As an operator, I can see LLM spend to date this month against its ceiling, before the invoice arrives.
- As an operator, I can answer "did the tool ever show a fabricated clause" with a number, not an opinion.
- As an operator, I can honor a data-deletion request within the statutory window, from a documented procedure rather than by writing SQL from memory.

## 7. The report

Each analysis produces:

**Overall risk** — low / medium / high. Derived by a deterministic server-side rule, not taken from the model:

> any high-severity finding → **high**; else any medium finding → **medium**; else **low**.

The model still reports its own overall risk; the server stores it separately (`modelRisk`) so disagreement between rule and model is measurable, but the rule is what the user sees. Known limitation, accepted through Phase 1: missing protections don't affect the risk level. Revisit when §11's drift metric has real data behind it.

**Summary** — two or three sentences in plain language.

**Findings** — ordered high → medium → low, each with:
- Category: payment, IP and ownership, scope and revisions, termination, liability, confidentiality, dispute resolution, other
- Severity: high / medium / low
- The clause, quoted verbatim from the document and verified to exist in it
- Why it matters, written for someone with no legal background
- A suggested change they could ask for, written to be sendable nearly as-is

**Missing protections** — standard clauses that should be present and aren't, checked against a fixed list: deposit/upfront payment, late-payment interest, revision limit, kill fee, IP transfer conditional on full payment, limitation of liability, scope-change process, portfolio rights.

**Disclaimer** — exact wording, shown on every report in body text, not a footer:

> ClauseCheck highlights clauses worth a second look before you sign. It isn't a lawyer and this isn't legal advice — for a high-stakes contract, have a professional review it.

This wording is **locked**. It is the product's primary defense against being treated as legal advice (§12.2, §17). Changing it requires legal review under §0.

## 8. Account and data lifecycle

### 8.1 Account states

| State | Reached by | Can sign in | Can analyze | Notes |
|---|---|---|---|---|
| `UNVERIFIED` | registration | yes | **no** | Verification email sent on registration; resend allowed, rate limited. |
| `ACTIVE` | following the verification link | yes | yes | The normal state. |
| `LOCKED` | repeated failed logins (SRS FR-1.10) | no | no | Time-boxed automatic unlock; no support ticket required. |
| `SUSPENDED` | operator action under §16 | no | no | Manual, logged, with a stated reason and an appeal address. |
| `DELETED` | user request, or operator action | no | no | Row and all descendants removed. Not a flag — the row is gone (§12.5). |

Requiring verification before analysis, rather than before login, is deliberate: it puts the friction where the cost is (an LLM call, a stored confidential document) rather than at the door, and it means a mistyped email is discovered while the user is still in the flow.

### 8.2 Data lifecycle

| Data | Retained | Deleted when | Notes |
|---|---|---|---|
| Account (email, password hash) | while the account exists | account deletion | |
| Document raw text | 90 days from upload, or until deleted | user delete, account delete, or the retention job | §12.4. The 90-day window is published in the privacy policy. |
| Analyses and findings | with their document | cascade from document delete | |
| Operational metrics (durations, token counts, error codes, finding counts) | 13 months | rolling job | Contains no document content and no excerpts (SRS §6.5). |
| Application logs | 30 days | log platform retention | |
| Database backups | 30 days, then destroyed | rolling | The one place deleted content survives, bounded and published (§12.4). |

## 9. Scope by phase

### Phase 1 — the working system

- Email/password auth
- Upload PDF, DOCX, or paste plain text
- Documents up to 4,000 words (roughly 8 pages)
- Single LLM call, synchronous response
- Full report as described above, with server-side excerpt verification
- Document history list and detail view
- Permanent delete

**Definition of done — all of these, checked honestly:**
1. Deployed at a public URL over HTTPS.
2. A person who isn't you signs up, analyzes a real contract, and reads the report without asking you anything.
3. A scanned (image-only) PDF produces the specific "no text layer" error, not a crash or a generic failure.
4. A mocked malformed model response produces one retry and then a clean user-facing error (demonstrable in tests).
5. A fabricated excerpt planted in a test is discarded and never shown.
6. User A cannot retrieve user B's document (returns 404).
7. README documents the architecture, the excerpt-verification defense, and the failure handling.
8. The accuracy benchmark runs against the fixture corpus and reports recall and precision as numbers (§11).

### Phase 1.5 — production hardening **(gate: no public launch without this)**

Phase 1's definition of done proves the system *works*. It does not make the system *operable* or *safe to point real users at*. Phase 1.5 is the difference, and it is a gate rather than a backlog because every item on it is something whose absence is only discovered at the worst possible time.

- **Account completeness**: email verification, password reset, session revocation, account deletion and data export (§8.1).
- **Abuse and cost limits**: per-user monthly analysis and spend ceiling; per-user storage quota; upload concurrency cap; alerting before ceilings are reached (§10.2).
- **Input hardening**: archive-bomb and page-count limits, encrypted-PDF handling, upload streaming (SRS §3.2).
- **Provider resilience**: retry with backoff on 429/529, circuit breaker, honest degraded-mode messaging (SRS §3.3).
- **Operability**: SLOs, dashboards, alerts with owners and thresholds, on-call runbooks, staging environment, CI/CD with migration and rollback policy (§14, SRS §8, §12).
- **Data protection**: retention job, backup/restore rehearsed at least once, DSAR procedure written down (§12).
- **Legal**: privacy policy, terms of service, subprocessor list, and the no-training commitment published (§12).
- **Accessibility**: WCAG 2.2 AA audit on the four core screens, blocking defects fixed (§13).
- **Pagination** on history, and API versioning under `/api/v1` (SRS §4).

**Phase 1.5 definition of done:**
1. An external tester recovers a forgotten password and deletes their account unaided; verified afterward that no rows remain.
2. A restore from backup into a scratch database succeeds, and the elapsed time is recorded against the RTO in §14.2.
3. A simulated provider outage (mocked 529 for five minutes) produces a stated degraded-mode error, no data loss, no pending analyses stuck, and one alert — not a pager storm.
4. A load test at the target concurrency (SRS §6.1, NFR-1.3) holds p95 latency within the SLO and does not exhaust server memory.
5. Every alert in SRS Appendix C has fired at least once in staging, deliberately, and reached the intended destination.
6. Privacy policy, terms, and subprocessor list are live and linked from the footer and the upload screen.
7. The accessibility audit's blocking defects are closed, and the report is committed.

### Phase 2 — after Phase 1.5 is live

- Long documents via chunking with overlap
- Background job queue; analysis runs async with real progress
- Clause highlighting in the original document text
- Export report as PDF
- Response caching by document hash (the hash column ships in Phase 1)

### Phase 3 — only if the product has momentum

- Compare two versions of a contract
- Contract-type-specific rulesets (retainer vs fixed-scope vs licensing)
- Team accounts
- Jurisdiction-aware advice (see D3)

## 10. Business model and unit economics

Even where the answer is "free for now," the numbers have to exist — an unmetered LLM product with no ceiling is a billing incident waiting for a quiet weekend.

### 10.1 Cost per analysis

From SRS §5.4's sizing at the 4,000-word cap: roughly 6,600 input tokens and 800–2,000 output tokens per analysis. At current published Anthropic pricing for the configured model, that is a small per-analysis cost in the low cents; the number that matters is not the estimate but the measured one, because §11 instruments actual token counts per analysis from day one. **Rule: the README quotes measured cost per analysis, never estimated.** Non-analysis infrastructure (managed Postgres, two app instances, object-free storage) is a fixed monthly floor independent of volume.

### 10.2 Ceilings, which are a product decision and not only a technical one

| Limit | Value | Rationale |
|---|---|---|
| Analyses per user per hour | 10 | Anti-abuse; a human checking contracts does not exceed this. |
| Analyses per user per month | 50 (free tier) | Bounds the cost of a single account to a known figure. |
| Documents stored per user | 100, or 50 MB of text | Bounds storage and the blast radius of a compromised account. |
| Platform LLM spend per month | a configured ceiling, alerting at 50% / 80% / 100% | At 100%, new analyses return a stated error rather than silently overspending. Existing reports stay readable. |

Hitting the platform ceiling is a **capacity event, not an outage**: the product degrades to read-only with an honest message, which is a better failure than an unbounded invoice. This is why SRS defines `SPEND_LIMIT_REACHED` as its own error code rather than folding it into a generic 503.

### 10.3 Monetization

Phase 1 and 1.5 are free with the ceilings above. Monetization is **deferred**, not rejected: the plausible shape is a free tier of a few analyses per month with a low monthly paid tier above it, and the instrumentation in §11 (real cost per analysis, real usage distribution) is what would make that priceable. No payment processing, no billing data, and therefore no PCI scope, in Phase 1 or 1.5.

## 11. Success metrics and instrumentation

Every metric below names a target and a guardrail. A metric with no threshold is a dashboard decoration.

### 11.1 Quality — the claim the product rests on

| Metric | Source | Target | Guardrail / alert |
|---|---|---|---|
| **Fabricated excerpts shown to a user** | pipeline-enforced; every displayed excerpt passed verification | **0**, structurally | Any nonzero is a Sev-1: the verification defense has failed. |
| **Recall** on high-severity planted clauses | fixture corpus (SRS §11) + answer key | ≥ 90% of high-severity expected findings | < 85% blocks release |
| **Precision** — clauses flagged that the key marks fair | `fair_clauses_do_not_flag` | ≥ 90% | < 85% blocks release |
| **Clean contract returns zero findings** | fixture 03 | exactly 0 findings, 0 missing protections | any nonzero blocks release |
| **Discard rate** — legitimate findings lost to strict matching | `discardedFindings` / total findings | < 5% in production | > 10% over 7 days triggers review of §5.3 strictness |
| **Rule/model risk drift** | `overallRisk` vs `modelRisk` | tracked, no target | > 25% disagreement prompts a rule review |

The corpus is synthetic on purpose. Real contracts don't come with an answer key for "what would hurt a freelancer," so a hand-checked set of real ones measures the reviewer's patience rather than the tool's accuracy. Planted clauses make the claim falsifiable.

**The benchmark runs in CI on every change to the prompt, the schema, the matcher, or the model identifier**, and its thresholds are release gates. A prompt edit that quietly costs 8 points of recall is otherwise invisible until a user is harmed by it.

### 11.2 Product

| Metric | Target |
|---|---|
| Signup → first finished report, unaided | < 3 minutes |
| Verification email → verified | > 70% within 24 h (below this, the email is landing in spam) |
| Analyses that end in a user-visible error | < 2% |
| Users returning for a second analysis within 30 days | tracked from launch; no target until there is a baseline |

### 11.3 Reliability — see §14 for the SLOs these roll up to

p95 analysis duration, availability of the analyze path, provider error rate, and database error rate. Targets in §14.1.

### 11.4 Instrumentation — recorded per analysis, from day one

- duration (ms), input tokens, output tokens, model name, provider request id
- finding count, discarded-finding count, rule-derived risk vs model-reported risk
- retry count, error code on failure
- word count and source type (never the text itself)

These numbers are the raw material for the README's "what I learned" section: real cost per analysis, real failure rate, real hallucination-catch rate.

### 11.5 Analytics and consent

Product analytics beyond the operational metrics above are **opt-in** and must never carry document content, excerpts, filenames, or summaries. No third-party analytics or session-replay script runs on any page that can display a report — a session recorder on the report screen would exfiltrate exactly the confidential text the product promises to protect. This is a hard rule, enforced by the frontend CSP (SRS FR-7.9), not a preference.

## 12. Legal, privacy, and compliance

The single most consequential gap between this product working and this product being usable: freelancers are frequently under an NDA covering the very document they want checked. A vague privacy story doesn't lose a sale, it makes the product unusable to the primary persona.

### 12.1 Roles and jurisdiction

ClauseCheck is the **data controller** for account data and for uploaded documents. The LLM provider and the hosting and database providers are **processors / subprocessors**. Operating jurisdiction and the applicable privacy regimes (GDPR / UK GDPR / CCPA, depending on where the operator and users are) must be **stated explicitly before launch** — this is an owner decision, not an engineering default, and it determines the DSAR clock in §12.5.

### 12.2 The unauthorized-practice-of-law boundary

The product must not present itself as, or be reasonably mistaken for, a lawyer.

- The §7 disclaimer wording is locked and appears in body text on every report, not in a footer.
- Suggested changes are phrased as **negotiation asks**, never as drafted legal language ("ask for a set number of revision rounds," not "insert the following clause").
- No jurisdiction-specific advice, no statutory citations (enforced by the system prompt, SRS Appendix A).
- Marketing copy is subject to the same rule as product copy: no "legal review," no "lawyer-approved," no "protects you."
- The terms of service disclaim reliance and state that no attorney-client relationship is created.

### 12.3 Subprocessors and the training commitment

Before launch, publish a subprocessor list naming the LLM provider, the hosting provider, the managed database provider, the email provider, and the error-tracking provider, each with its purpose and processing region. Two commitments must be verified against the provider's actual terms and then stated publicly:

1. **Document content is not used to train models.** Verify this against the LLM provider's commercial terms and record the date and the term verified. Re-verify at each annual review and whenever the provider's terms change.
2. **Provider-side retention** of prompt content: state the provider's retention window. If it can be reduced or eliminated contractually, do so before launch.

A Data Processing Agreement with the LLM provider is required before public launch. Error tracking must be configured to scrub request bodies, so that an exception carrying document text cannot reach a third party (SRS §6.5).

### 12.4 Retention

Published, and enforced by a scheduled job rather than by intention:

- Document text and its analyses: **90 days from upload**, or until deleted, whichever is first.
- Backups: **30 days**, then destroyed. This is the one place a deleted document persists; the privacy policy says so plainly rather than making a "deleted immediately everywhere" claim that backups make false.
- Operational metrics: 13 months, content-free.
- Logs: 30 days.

D1 (store raw text) is **reaffirmed and now bounded**: retained for a stated window, deletable on demand, excluded from logs, and covered by a published policy. The v2.1 note "revisit before any real marketing" is hereby resolved by this section.

### 12.5 User rights

| Right | Mechanism | Target |
|---|---|---|
| Access / portability | Self-serve export: account data, document list, and full reports as JSON | Immediate, in-product |
| Erasure | Self-serve account deletion, hard, cascading | Immediate in-product; backups age out within 30 days |
| Rectification | Email change with re-verification | In-product |
| Objection / withdrawal | Deleting the account, or declining opt-in analytics | In-product |
| DSAR received by email | Documented runbook (SRS §12.4), identity verified before action | Within the statutory window for the declared jurisdiction |

Deletion is **hard and cascading**, per D2. There is no undelete, and the interface says so before it happens.

### 12.6 Out of scope for Phase 1 / 1.5, explicitly

No SOC 2, no HIPAA/BAA, no ISO 27001, no data-residency choice, no enterprise SSO, no under-18 users. These are stated so that a prospective user can tell immediately whether the product is appropriate for them, and so that no one has to invent an answer on the spot. Selling to buyers who require any of these is a Phase 3 decision with real cost attached.

### 12.7 Security disclosure

A `security.txt` and a published contact address, with a stated acknowledgment target of 72 hours and a commitment not to pursue good-faith researchers. Free, and its absence is conspicuous.

## 13. Accessibility

**Commitment: WCAG 2.2 Level AA** on the four core screens — upload, analyzing, report, history — and on the auth screens. Not aspirational: audited in Phase 1.5, with the report committed to the repository and blocking defects fixed before launch.

The requirements that this specific product makes non-negotiable:

- **Severity is never conveyed by color alone.** It carries a text label and a distinct shape or icon. Risk levels are the entire information design of the report; a red badge alone is unreadable to a large fraction of the intended audience.
- **The report is a document, not a widget.** Correct heading hierarchy, real landmarks, findings as a list — so a screen reader user can navigate by heading and skip between findings.
- **Copy-to-clipboard is keyboard-operable** and announces its confirmation to assistive technology, not only visually.
- **The analyzing screen's staged progress is announced politely** via a live region, and does not steal focus.
- **Contrast ≥ 4.5:1** for text, including inside severity badges — the usual place a design fails this.
- **Targets ≥ 24×24 px** and the whole flow usable at 320 px width and 200% zoom, because §2.2 says the first use is on a phone.
- **Errors are associated with their fields** programmatically and describe the fix.
- **Respects `prefers-reduced-motion`.**

## 14. Reliability, support, and incidents

### 14.1 Service level objectives

| SLO | Target | Measured over |
|---|---|---|
| Availability, analyze path (non-5xx, excluding deliberate 4xx) | 99.5% | calendar month |
| Availability, read paths (login, history, report) | 99.9% | calendar month |
| p95 analysis duration at the word cap | < 45 s | rolling 7 days |
| p95 latency, all non-analysis endpoints | < 500 ms | rolling 7 days |
| Error budget policy | at 100% burn, feature work stops until reliability work restores it | monthly |

99.5% is chosen deliberately over a higher number: the analyze path depends on a third-party model provider, and promising availability the dependency doesn't offer is how an SLO becomes decoration.

### 14.2 Continuity

| | Target |
|---|---|
| **RPO** (data loss tolerated) | 24 hours, from managed daily backups plus point-in-time recovery where the provider offers it |
| **RTO** (time to restore service) | 4 hours |
| **Rehearsal** | a restore into a scratch database, executed and timed at least once in Phase 1.5 and every 6 months after; an unrehearsed backup is a hypothesis |

### 14.3 Incident severities

| Sev | Definition | Response |
|---|---|---|
| **Sev-1** | A fabricated excerpt reached a user; document content leaked or exposed cross-user; data loss | Immediate. Disable the affected path if needed. Post-incident review required. |
| **Sev-2** | Analyze path down or failing > 25% for > 15 minutes; auth broken | Same-day, paged |
| **Sev-3** | Elevated error or discard rate; degraded latency | Next business day |
| **Sev-4** | Cosmetic, single-user | Backlog |

Every Sev-1 and Sev-2 gets a written review focused on the mechanism, not the person — and its output is a change to a spec, a test, or an alert, not a reminder to be careful.

### 14.4 Support

A single published support address, a target of one business day for first response, and a status page or equivalent for incidents affecting the analyze path. A user whose analysis just failed on a contract due Friday needs to know whether to wait or to go elsewhere.

## 15. Launch and rollout

| Stage | Gate | Exit criterion |
|---|---|---|
| **Internal** | Phase 1 DoD | The owner runs ten real contracts through it and reads every report |
| **Closed beta** (≤ 25 invited freelancers) | Phase 1.5 DoD | Two weeks with no Sev-1; ≥ 5 users complete signup → report unaided; qualitative feedback on whether findings were useful |
| **Public** | legal §12 items live; accessibility audit closed; alerts rehearsed | announced publicly |

Rollback plan: the frontend is a static deploy with immediate rollback to the previous build; the API rolls back by redeploying the previous image, with the migration policy in SRS §12.2 guaranteeing the previous version still runs against the current schema. There is a documented feature switch to disable new analyses while leaving existing reports readable — the correct response to a provider incident, a spend ceiling, or a discovered prompt regression.

## 16. Trust and safety

Uploads are user-supplied documents, and a fraction of them will not be contracts.

- **Prohibited uses**, stated in the terms: uploading documents the user has no right to share, attempting to extract the system prompt, automated bulk submission, and using the output as a substitute for legal advice in high-stakes matters.
- **Non-contract documents** get the model's honest "this doesn't appear to be a contract" path (SRS Appendix A) rather than an invented analysis.
- **Malicious documents** — prompt injection, archive bombs, malformed PDFs — are handled as security requirements (SRS §6.2), not as content moderation.
- **Enforcement**: rate limits and ceilings first; account suspension (§8.1) only for repeated deliberate abuse, logged, with a stated reason and an appeal route.
- ClauseCheck does **not** scan document contents for policy violations. Doing so would require reading confidential documents for a purpose the user did not consent to, which contradicts §12. Abuse is judged from usage patterns and metadata, never from content.

## 17. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Model invents a clause that isn't in the document | High | Require verbatim excerpts; verify each against source text server-side before saving; drop failures and count them. Alert on any displayed unverified excerpt (§11.1). |
| Users treat output as legal advice | High | Locked disclaimer wording (§7) in body text; negotiation-ask phrasing; ToS disclaimer; marketing copy held to the same rule (§12.2). |
| Confidential document leaked via logs, error tracking, or analytics | High | Never log document text or excerpts; error tracker scrubs bodies; no third-party script on report pages, enforced by CSP (§11.5, SRS §6.5). |
| Confidential document exposed to another user | High | Ownership check on every read, 404 not 403; automated test TR-4; cross-user access is a Sev-1. |
| Provider outage or deprecation of the configured model | High | Model identifier is configuration, not code; circuit breaker and honest degraded mode; benchmark (§11.1) is the gate for switching models, so a swap is a measured decision rather than a hope. |
| API costs spiral | Medium | Per-user hourly and monthly ceilings, platform spend ceiling with staged alerts, hard word cap, token usage logged per analysis (§10.2). |
| Malicious instructions embedded in an uploaded contract steer the model | Medium | Document treated strictly as delimited data; the system prompt refuses instructions inside it; verification bounds the worst case to quoting real text. A suppression attack yields at worst a false-clean report, which the disclaimer covers. |
| Malicious file exhausts server resources (archive bomb, huge PDF) | Medium | Size, page, and expansion-ratio limits before parsing; upload concurrency cap; memory ceiling with restart (SRS §3.2). |
| Prompt or model change silently degrades accuracy | Medium | Benchmark in CI with release-gating thresholds (§11.1). |
| Legal exposure from a bad or missed finding | Medium | Disclaimer, ToS limitation of liability, jurisdiction-neutral output, no drafted clauses. Legal review of §12 before public launch. |
| Scope creep into chat and redlining | Medium | Non-goals (§4). Re-read when tempted. |
| Single-maintainer bus factor | Medium | Everything operational is written down: runbooks, alert thresholds, restore procedure, env inventory. The test of this section is whether someone else could run it from the repo alone. |

## 18. Decisions log

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Store raw document text after analysis? | **Store it, bounded to 90 days**, hard delete available and permanent. | Enables Phase 2 clause highlighting and re-analysis. The v2.1 caveat is resolved by §12.4: the privacy story is a published, enforced retention window plus delete-on-demand, not never-retained. |
| D2 | Soft delete or hard delete? | **Hard delete**, cascading to analyses and findings. | The documents are confidential by nature; "deleted" must mean deleted. Losing undo is an acceptable cost, and §4 says ClauseCheck is not a system of record. |
| D3 | Capture the freelancer's country for jurisdiction-aware advice? | **No — deferred to Phase 3.** All advice stays jurisdiction-neutral; the disclaimer carries the weight. | Doing jurisdiction properly is a large, ongoing correctness burden; doing it partially is worse than not doing it. |
| D4 | Require email verification? | **Yes, before analysis rather than before login.** | Puts friction where the cost is; catches a mistyped address while the user is still in the flow; blocks the cheapest form of account abuse. |
| D5 | JWT with no server-side revocation? | **No — add a `tokenVersion` claim**, bumped on password reset, sign-out-everywhere, and deletion. | A 7-day bearer token with no kill switch is not acceptable for confidential documents. A version integer is far cheaper than session storage and covers the cases that matter. |
| D6 | Soft launch publicly on Phase 1? | **No.** Phase 1.5 is a gate. | Phase 1 proves the system works; it does not make it operable or lawful to point at real confidential documents. |
| D7 | Show users the model's own risk claim? | **No.** Server-derived risk only; `modelRisk` is stored for drift measurement. | Two risk numbers that disagree destroy trust and are unexplainable in the interface. |
| D8 | Charge in Phase 1? | **No — free with hard ceilings.** Monetization deferred, not rejected. | Instrumented real cost is what makes pricing a decision rather than a guess. Avoids all payment and PCI scope in the early phases. |
| D9 | Fuzzy excerpt matching to reduce false discards? | **No.** Strict normalized substring only. | Near-miss tolerance is exactly the hole a paraphrasing model slips through. The cost is measured (`discardedFindings`) and revisited with data, not with intuition — the threshold for revisiting is in §11.1. |
| D10 | Scan uploaded documents for abuse? | **No.** Abuse judged from usage patterns and metadata only. | Reading confidential documents for an unconsented purpose contradicts the product's central promise (§16). |
| D11 | Third-party analytics or session replay? | **Not on any page that can display a report**, and product analytics opt-in only. | A session recorder on the report screen exfiltrates exactly the text the product promises to protect. Enforced by CSP, not policy. |
| D12 | Availability target? | **99.5% on the analyze path**, 99.9% on read paths. | The analyze path inherits a third-party dependency's availability. Promising more than the dependency offers makes the SLO meaningless. |
| D13 | Behavior at the platform spend ceiling? | **Degrade to read-only** with a distinct error code; existing reports stay readable. | A bounded, honest outage of one feature beats an unbounded invoice or a silent generic failure. |
| D14 | Who signs off on legal copy? | **External counsel reviews §12 and the ToS before public launch**; the §7 disclaimer wording is locked. | The UPL boundary is the one risk here that cannot be engineered away. |

## 19. Remaining open questions

- Should Phase 2's PDF export include the disclaimer on every page, given the report will circulate detached from the interface? (Leaning yes.)
- Is 10 analyses/hour/user the right rate limit once real users exist, or should the meaningful limit be the monthly one alone? Answer with beta data.
- Does the 90-day retention window (§12.4) match what beta users actually expect? Some will want zero retention; a per-user "delete after analysis" preference is a plausible Phase 2 addition.
- Once §11.1's drift metric has data, should missing protections influence overall risk (currently a known limitation of §7)?
- At what usage does the synchronous Phase 1 request model stop being viable, and does that arrive before or after the Phase 2 queue is worth building?
