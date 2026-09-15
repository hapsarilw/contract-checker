# Phase 1 definition of done — verification record

PRD §9, "Definition of done" for Phase 1, checked item by item (BUILD-PLAN step 43). Verified 2026-09-15 against the repository as of this file's commit.

**Gate verdict: NOT PASSED.** Five of eight items are verified. The other three are outstanding, and none of them can be closed by the builder alone: each needs an account, a credential, or a person that only the owner can provide.

| # | Item | Verdict |
|---|---|---|
| 1 | Deployed at a public URL over HTTPS | **Outstanding** |
| 2 | A person who isn't the builder signs up, analyzes a real contract, reads the report unaided | **Outstanding** |
| 3 | A scanned image-only PDF produces the specific "no text layer" error | **Verified** (a gap was found and fixed during this check) |
| 4 | A mocked malformed model response produces one retry, then a clean user-facing error | **Verified** |
| 5 | A fabricated excerpt planted in a test is discarded and never shown | **Verified** |
| 6 | User A cannot retrieve user B's document (404) | **Verified** |
| 7 | README documents the architecture, the excerpt-verification defense, and the failure handling | **Verified** |
| 8 | The accuracy benchmark reports recall and precision as numbers | **Outstanding** |

---

## 1. Deployed at a public URL over HTTPS — Outstanding

Nothing is deployed. There is no hosting configuration in the repository and `.github/workflows/` is empty. `server/Dockerfile` and `docker-compose.yml` exist (step 40) and the image has been built and run locally, but a container image isn't a deployment.

**To close:** pick a host (SRS §8 names Render or Railway for the API and Vercel or Netlify for the frontend), then deploy with real secrets set in the platform's secret store, never in the repository. Step 71 is the planned real deployment. Deploying a preview earlier would close this item for the gate.

## 2. A real person completes the journey unaided — Outstanding

This hasn't happened, and it can't be simulated. Two things currently stand in the way:

- **It needs a real model.** With the mock provider the report is a fixed placeholder, so a tester would be reading output the product never generated. Item 8's blocker (no API key) applies here too.
- **It needs a URL, or the tester at the builder's machine.** In practice that means item 1 first.

**Caution for when it happens:** PRD §9's Phase 1.5 introduction says the system is not yet lawful to point at real confidential documents. The privacy policy, the subprocessor list, and the no-training commitment aren't published yet. The tester should use a contract they're free to share (not one under NDA), and should know where the text is sent.

**To close:** after items 1 and 8, have someone who has never seen the app register, upload a contract, and read the report while you watch without helping. Record where they hesitated.

## 3. Scanned image-only PDF → the specific "no text layer" error — Verified

Fixture 06 (`server/tests/fixtures/06-scanned-no-text-layer.pdf`, rasterised pages with no text layer) is rejected with `422 DOCUMENT_TOO_SHORT`. The message names the likely cause ("…a scanned image with no selectable text…") instead of a generic "too short". It isn't a crash and it isn't a 500.

Evidence:
- `server/tests/unit/pdf.test.js` shows the PDF parses without throwing. A scan is a valid PDF with no useful content, not a parser failure.
- `server/tests/unit/intake.test.js`, "the scanned PDF with no text layer returns DOCUMENT_TOO_SHORT (06-scanned-no-text-layer.pdf)", asserts the code and a message matching `/scanned image/i`.
- **Added during this check:** `server/tests/integration/documents.test.js`, "returns 422 DOCUMENT_TOO_SHORT naming a scanned image for an image-only PDF (fixture 06), and stores nothing". It covers the same outcome through the real `POST /api/v1/documents` route.
- `client/e2e/upload.spec.js`, "DOCUMENT_TOO_SHORT from an upload renders the scanned-PDF copy", covers what the user actually sees.

**Gap found and fixed:** before this check, fixture 06 was only tested at the service level (`intakeUpload()` called directly). Multer, magic-byte detection, and the error translator all sit between an upload and that service, and any of them could have turned a scan into a generic failure without a test noticing. The new route-level test is load-bearing. As a check, the route was changed so an intake failure becomes a plain `Error` (a 500), the test failed as expected, and the route was restored byte-identical.

## 4. Malformed model response → one retry → clean user-facing error — Verified (TR-5)

Evidence, using the scripted mock provider:
- `server/tests/integration/analyze.test.js`, "TR-5 — invalid model output (FR-3.2)":
  - "retries exactly once with the correction, then 502 LLM_INVALID_OUTPUT, FAILED with both calls' tokens". A third valid response is scripted and never consumed, which proves there is no second retry. The second call carries the correction quoting the parse error.
  - "succeeds when the one retry returns valid output, counting both calls".
- `client/tests/unit/analyzeErrors.test.js` and `client/tests/unit/AnalyzingPanel.test.jsx` cover the `LLM_INVALID_OUTPUT` error card ("The check didn't finish.") with a working "Try again".
- `client/e2e/analyzing.spec.js`, "LLM_INVALID_OUTPUT", checks that state against a mocked 502 in a real browser.

## 5. Fabricated excerpt → discarded, never shown — Verified (TR-3, TR-7)

Evidence:
- `server/tests/unit/verify.test.js`, "TR-3 — excerpt verification". It covers all six named cases: an exact match passes; case and whitespace variants pass; a curly-quote variant passes; a fabricated excerpt is discarded; an excerpt lifted from a *different* document is discarded; and a paraphrase of a real clause in the same document is discarded. The paraphrase case is the one a fuzzy matcher would wrongly admit (PRD D9).
- `server/tests/integration/analyze.test.js`:
  - "drops unverifiable findings, counts them, and derives risk from the survivors only". The fabricated finding is absent from the response body and from the stored rows, and `discardedFindings` is 1.
  - "TR-7 — every excerpt fails verification": `502 ALL_FINDINGS_DISCARDED`, `FAILED`, zero stored findings, never presented as a clean report.
- `npm run fixtures:verify` (server) reports: "18 excerpt(s) verified across 3 document(s), each in txt and pdf form; 3 fabricated excerpt(s) confirmed absent". The answer key's `fabricated_excerpts` really are absent from the shipped fixtures, so the TR-3/TR-7 inputs test what they claim to.
- `client/e2e/analyzing.spec.js`, "ALL_FINDINGS_DISCARDED", covers the user-facing state.

## 6. User A cannot retrieve user B's document — Verified (TR-4)

Evidence:
- `server/tests/integration/documents.test.js`: "returns 404, not 403, for another user's document (TR-4)" on `GET /api/v1/documents/:id`, and the same on `DELETE`, where the document is also left intact.
- `server/tests/integration/analyze.test.js`, "TR-4 — ownership (FR-1.5)": another user's analyze attempt returns 404 before any analysis row is written or the provider is called. A nonexistent id returns the same 404, so the two cases can't be told apart.
- `server/tests/integration/ownership.test.js` covers `loadOwnedDocument`, the single control every document route uses.

## 7. README — Verified

`README.md` (step 42) has sections for the architecture (including SRS §2's two critical constraints), the excerpt-verification defense (mechanism, reasoning, and PRD D9's ban on fuzzy matching), and failure handling. The failure-handling section states plainly that provider-outage retries and the circuit breaker (FR-3.10, FR-3.12) are specified but not yet built. Its "Measured cost per analysis" section says "Not yet measured" rather than estimating, as PRD §10.1 requires.

## 8. Accuracy benchmark — recall and precision as numbers — Outstanding

**No numbers are recorded, deliberately.** This environment has no `ANTHROPIC_API_KEY` (checked in the shell, `server/.env`, `client/.env`, and the repository root, without printing any value). The only provider available is the mock, and running fixtures 01–04 through it would measure the mock, not the model. By default it returns an empty findings array, so recall would be 0% by construction. Recording that as "preliminary recall" would be a fabricated result wearing a real result's label. The Done-when condition "recall and precision exist as numbers" is therefore **not met**.

**To close:** provide a key with a spend ceiling and run `POST /documents` + `/analyze` once each for fixtures 01, 02, 03, and 04 with `LLM_PROVIDER=anthropic`. That's four analyses, low cents at the 4,000-word cap (PRD §10.1). Record the real token counts from the `Analysis` rows; those same rows are what the README's cost section needs.

Scoring for this manual run is provisional. Step 72's `scripts/benchmark.js` formalises it. It's written down here so the numbers are reproducible:
- **Match rule:** a returned finding matches an expected one when, after `normalizeForMatch` (`server/src/services/verify.js`, the same normalisation the verifier uses), one excerpt contains the other.
- **Recall (PRD §11.1's gate metric):** matched ÷ expected, over high-severity findings only. The key has 7: five in 01, none in 02, two in 04. Also report recall over all severities for context.
- **Precision:** returned findings that match an entry in the key's `findings` or `also_acceptable`, ÷ all returned findings, over 01, 02, and 04. Any hit on a `fair_clauses_do_not_flag` entry (fixture 04) is reported by name as a false positive.
- **Also record:** fixture 03's finding count (the gate requires exactly 0), each document's derived `overallRisk` against the key's `overall_risk`, and `discardedFindings` per run.

---

## Test runs recorded for this check

| Suite | Result |
|---|---|
| server unit, full (`npm run test:unit`) | 488 passed |
| server integration, full (`npm run test:integration`) | 158 passed (includes the new fixture 06 route test) |
| server `npm run fixtures:verify` | OK: 18 excerpts verified, 3 fabricated confirmed absent |
| client unit, `analyzeErrors` + `AnalyzingPanel` | 23 passed |
| client e2e, `analyzing.spec.js` LLM_INVALID_OUTPUT + ALL_FINDINGS_DISCARDED | 2 passed |

## After the gate: Phase 1.5 is a gate, not a backlog

PRD §9 (and decision D6): Phase 1's definition of done proves the system *works*. It doesn't make the system operable, or lawful to point at real confidential documents. Missing today: email verification and password reset, per-user quotas and a spend ceiling, the retention job, provider retry and circuit breaker, dashboards and alerts, a rehearsed backup restore, and a published privacy policy, terms, and subprocessor list. **No public launch until step 75**, whatever happens to items 1, 2, and 8 above.
