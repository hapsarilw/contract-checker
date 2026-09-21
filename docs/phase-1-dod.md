# Phase 1 definition of done — verification record

PRD §9, "Definition of done" for Phase 1, checked item by item (BUILD-PLAN step 43). Verified 2026-09-15 against the repository as of this file's commit. **Item 8 re-checked 2026-09-21** once a real `ANTHROPIC_API_KEY` existed; see the revision note at the end of that section.

**Gate verdict: NOT PASSED.** Six of eight items are verified. The other two are outstanding, and neither can be closed by the builder alone: each needs an account or a person that only the owner can provide.

**Item 8 now carries numbers, and the numbers are not all good.** Recall passes its PRD §11.1 threshold outright and has never moved off 100%. Precision failed at first and was fixed by a prompt revision (`analyze-v1` → `v3`); per-document risk correctness is still 3/4 and did not respond to the prompt. Those are step 72's release gates, not step 43's — item 8 asks only that the measurement exist — so they do not block this gate. Read §8 before choosing a model. Two findings there change what this project should ship: **two runs of the same prompt over the same documents at `temperature: 0` did not agree**, so the benchmark cannot gate a release until it runs repeats; and once repeats were added, **`claude-sonnet-5` at the existing `effort: low` fixed risk correctness outright (4/4, stable) as a configuration change alone**, which two prompt revisions had failed to do.

| # | Item | Verdict |
|---|---|---|
| 1 | Deployed at a public URL over HTTPS | **Outstanding** |
| 2 | A person who isn't the builder signs up, analyzes a real contract, reads the report unaided | **Outstanding** |
| 3 | A scanned image-only PDF produces the specific "no text layer" error | **Verified** (a gap was found and fixed during this check) |
| 4 | A mocked malformed model response produces one retry, then a clean user-facing error | **Verified** |
| 5 | A fabricated excerpt planted in a test is discarded and never shown | **Verified** |
| 6 | User A cannot retrieve user B's document (404) | **Verified** |
| 7 | README documents the architecture, the excerpt-verification defense, and the failure handling | **Verified** |
| 8 | The accuracy benchmark reports recall and precision as numbers | **Verified** 2026-09-21 (the numbers exist; two of them are below PRD §11.1's release thresholds — see §8) |

---

## 1. Deployed at a public URL over HTTPS — Outstanding

Nothing is deployed. There is no hosting configuration in the repository and `.github/workflows/` is empty. `server/Dockerfile` and `docker-compose.yml` exist (step 40) and the image has been built and run locally, but a container image isn't a deployment.

**To close:** pick a host (SRS §8 names Render or Railway for the API and Vercel or Netlify for the frontend), then deploy with real secrets set in the platform's secret store, never in the repository. Step 71 is the planned real deployment. Deploying a preview earlier would close this item for the gate.

## 2. A real person completes the journey unaided — Outstanding

This hasn't happened, and it can't be simulated. One thing still stands in the way:

- **It needs a URL, or the tester at the builder's machine.** In practice that means item 1 first.

**Resolved 2026-09-21:** the "it needs a real model" blocker is gone. A key exists, `LLM_PROVIDER=anthropic` runs end to end against `claude-haiku-4-5`, and §8's run shows the reports are genuinely model-generated rather than the mock's placeholder. What a tester would read today is real output — see §8's precision result for what they'd be reading wrong.

**Caution for when it happens:** PRD §9's Phase 1.5 introduction says the system is not yet lawful to point at real confidential documents. The privacy policy, the subprocessor list, and the no-training commitment aren't published yet. The tester should use a contract they're free to share (not one under NDA), and should know where the text is sent.

**To close:** after item 1, have someone who has never seen the app register, upload a contract, and read the report while you watch without helping. Record where they hesitated.

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

## 8. Accuracy benchmark — recall and precision as numbers — Verified 2026-09-21

The numbers exist and were measured, not estimated. Item 8 asks for exactly that, so it is closed. Two of the numbers are below PRD §11.1's release thresholds; §11.1's gates belong to step 72, not to this one, so they do not block step 43 — but they are recorded here in full because they change what model the project should ship with.

**The run.** Four analyses through the real HTTP API (`POST /api/v1/documents` with the fixture's `.txt` as pasted text, then `POST /api/v1/documents/:id/analyze`), `LLM_PROVIDER=anthropic`, `ANTHROPIC_MODEL=claude-haiku-4-5`, prompt `analyze-v1`, against a local Postgres. The `.txt` form was used rather than `.pdf` so the measurement isolates model accuracy from PDF extraction; the fixture verifier already proves the two forms carry the same excerpts.

### Gate metrics

| Metric | Result | PRD §11.1 threshold | Verdict |
|---|---|---|---|
| Recall, high-severity planted clauses | **7/7 = 100%** | ≥ 90%, < 85% blocks | **Passes** |
| Precision, `fair_clauses_do_not_flag` (§11.1's definition) | **2/3 = 66.7%** | ≥ 90%, < 85% blocks | **Fails — would block release** |
| Precision, all returned findings vs `findings` + `also_acceptable` (the broader rule §8 wrote down in advance) | **15/26 = 57.7%** | not a §11.1 gate | Context |
| Fixture 03 returns exactly zero findings | **0 findings** | exactly 0 | **Passes** |
| Every document's derived `overallRisk` matches the key | **3/4** | all 4 | **Fails — would block release** |

The two precision figures measure different things and PRD §11.1's table names only the first. Step 72's `scripts/benchmark.js` must settle which one the CI gate computes; the §11.1 wording ("clauses flagged that the key marks fair", sourced from `fair_clauses_do_not_flag`) is the narrower one and is the gate as written today.

### Per document

| Fixture | Risk expected | Risk derived | Model's own claim | Findings returned | Key findings matched | Discarded | Duration |
|---|---|---|---|---|---|---|---|
| 01 design-services-hostile | HIGH | HIGH ✓ | HIGH | 11 | 7/7 | 0 | 41.3 s |
| 02 dev-retainer-moderate | MEDIUM | **HIGH ✗** | MEDIUM | 8 | 4/4 | 0 | 15.2 s |
| 03 copywriting-clean | LOW | LOW ✓ | LOW | 0 | n/a | 0 | 1.8 s |
| 04 video-production-mixed | HIGH | HIGH ✓ | MEDIUM | 7 | 3/3 | 0 | 13.7 s |

Every planted finding in the key was found, at every severity, in all three documents that have any — 14/14 overall. The model's weakness here is not blindness; it is over-flagging.

### The two failures, named

**Fixture 02's risk is wrong, and it is the model's per-finding severity that is wrong, not the server's rule.** The key rates this contract MEDIUM and plants no high-severity clause in it. The model returned one finding at HIGH — the bug-fix obligation, "Developer shall address bug reports submitted by Client relating to the Services…" — and FR-3.9's derivation correctly turned one HIGH finding into an overall HIGH. Note that the model's *own* `modelRisk` claim for this document was MEDIUM, matching the key: it contradicted itself between the finding severity and the overall claim, and the server rule faithfully propagated the finding. This is a prompt/severity-calibration problem for step 72, not a risk-derivation bug. (The same divergence on fixture 04 runs the other way and vindicates FR-3.9: the model claimed MEDIUM, the server derived HIGH, and HIGH is what the key says.)

**One fair clause was flagged.** Fixture 04, the payment term the key marks favourable: "Fifty percent (50%) of the total fee is due upon execution of this Agreement, with the balance due within thirty (30) days of final delivery." The model returned a fragment of it — "with the balance due within thirty (30) days of final delivery." — as MEDIUM/PAYMENT. The other two fair clauses (IP on full payment, two revision rounds included) were correctly left alone. Flagging a 50%-deposit/net-30 term as a risk is the exact failure mode `fair_clauses_do_not_flag` exists to catch: it teaches a freelancer to distrust a clause that is in their favour.

The 11 unmatched findings behind the 57.7% figure are a mix. Some are defensible judgement calls the key simply doesn't list (a Delaware forum-selection clause against a solo freelancer; an unspecified liability cap). Others are noise — fixture 02's "Client shall designate a single point of contact" is an ordinary administrative term returned as a finding in two separate documents. Step 72 should decide which of these belong in `also_acceptable` and which are true false positives; recording them as false positives here is the conservative reading.

### Cost and instrumentation

From the four `Analysis` rows, which is what PRD §10.1 and the README's cost section need:

| | Input tokens | Output tokens | Retries |
|---|---|---|---|
| 01 | 7,340 | 4,750 | **1** |
| 02 | 2,251 | 1,565 | 0 |
| 03 | 2,317 | 111 | 0 |
| 04 | 2,299 | 1,294 | 0 |
| **Total** | **14,207** | **7,720** | 1 |

At `claude-haiku-4-5` list pricing (USD 1.00 per Mtok input, USD 5.00 per Mtok output): **USD 0.0528 for four analyses, USD 0.0132 average per analysis.** Fixture 01's input token count is inflated by its retry — the retry resends the conversation — so a clean single-call analysis of a ~900-word contract costs closer to USD 0.009.

**Fixture 01 retried once, against the real model, and succeeded on the retry.** This was not scripted. It is independent corroboration of item 4 (FR-3.2's single-retry-with-correction path), which until now had only been exercised against the mock provider.

### What this means for the model choice

BUILD-PLAN D-F says to start at the cheapest candidate and let the benchmark, not intuition, promote up the price ladder. The benchmark has now spoken, and its answer is *not yet*: Haiku 4.5 finds everything but over-flags, which is the failure that PRD §11.1's precision gate and `fair_clauses_do_not_flag` were written to block. Before promoting to `claude-sonnet-5` or `claude-opus-5`, step 72 should first try a prompt revision aimed at severity calibration and at leaving favourable clauses alone — a prompt fix is free at inference time and a model upgrade is not, and a model that over-flags on a weak prompt may over-flag on a strong one too. Whatever is tried, re-run this measurement; PRD §11.1 makes it a gate on every prompt, schema, matcher, or model change.

### Prompt revision: analyze-v2 and analyze-v3 (2026-09-21)

The v1 numbers above prompted a prompt fix rather than a model upgrade, on the reasoning recorded below. PRD §11.1 makes the benchmark a gate on every prompt change, so each revision was re-run over the same four fixtures.

**What changed.** v1 never told the model that the protections in its own MISSING CLAUSES checklist are good news when present, so the model returned a liability cap, a 50%-deposit/net-30 payment term and a point-of-contact clause as risks. v2 added a `NOT A FINDING` section stating that protection is not risk, made SEVERITY turn on whether the exposure is bounded, and added a worse-off-without-it test to JUDGMENT. v3 narrowed v2's boundedness rule after v2 read "no end date" on a confidentiality obligation as unbounded and promoted it to high: boundedness is now scoped to what the freelancer can *lose*, a say-or-show restriction stays medium however permanent, a non-compete stays high, and the agreed fee itself stopped being a finding.

**Results, one run per column except v3 which was run twice:**

| Metric | v1 | v2 | v3 run 1 | v3 run 2 |
|---|---|---|---|---|
| High-severity recall | 7/7 | 7/7 | 7/7 | 7/7 |
| Precision, `fair_clauses_do_not_flag` | 2/3 | **3/3** | 2/3 | **3/3** |
| Precision, all returned findings | 57.7% | 75.0% | 75.0% | 71.4% |
| Fixture 03 findings | 0 | 0 | 0 | 0 |
| `overallRisk` matches the key | 3/4 | 3/4 | 3/4 | 3/4 |
| Findings returned on fixture 01 | 11 | 11 | 8 | 9 |
| Discarded findings | 0 | 0 | 0 | 0 |

**The prompt fix worked, on the thing it was aimed at.** Broad precision moved from 57.7% to a 71–75% band and stayed there across three runs of two revisions, while recall never moved off 100%. The specific false positives that motivated the change are gone: no run after v1 flagged a liability cap, and fixture 04's finding count fell from 7 to 3–5.

**The risk mismatch did not get fixed, and the reason is worth more than the number.** Every revision still scores 3/4 on `overallRisk` — but not on the same document. Under v2 fixture 02 derived HIGH from the confidentiality clause. Under v3 run 1 it derived HIGH from the bug-fix clause instead, the very clause v3's text names as bounded and medium-at-most. Under v3 run 2 fixture 02 came out MEDIUM, correctly — and fixture 04 came out MEDIUM, wrongly. The failure moves around.

### The benchmark is not yet reproducible, and that is a finding about the method

**v3 run 1 and v3 run 2 are the same prompt, the same four documents, the same model, and `temperature: 0` — and they disagree.** Risk correctness landed on a different document, one flagged a fair clause and the other did not, and broad precision differed by 3.6 points. Nothing in the repository changed between them.

This matters more than any single figure above:

- **A one-run benchmark cannot gate a release.** SRS §10.4 has `scripts/benchmark.js` failing the build below 85%. Run-to-run spread on four documents is wide enough that a gate built on one run would flap, blocking good changes and passing bad ones. Step 72 should run each fixture several times and gate on an aggregate, and record the spread, not just the mean.
- **The v2-versus-v3 comparison above cannot be read finely.** v2 and v3 are indistinguishable at this sample size. v3 is kept because its rule is *more correct in principle* — v2 would classify every perpetual NDA as high severity — not because it measured better. That is a judgement, and it is recorded as one.
- **Four synthetic documents is a small corpus.** Step 72 adds fixtures 09–12, which will help.

### Where this leaves the model choice

BUILD-PLAN D-F says to let the benchmark, not intuition, promote up the price ladder. The benchmark now says something more specific than "not yet": prompt wording fixed the false-positive problem and did not fix the severity-calibration problem, and the residual failure is instability rather than a consistent wrong answer. A third prompt revision aimed at the same target has a poor prospect — v3 already states the rule the model then ignored in run 1.

That makes a model comparison the next reasonable experiment rather than a premature one: run the same four fixtures, several times each, on `claude-haiku-4-5` and on `claude-sonnet-5`, and compare self-consistency as well as accuracy. Both `MODEL_PARAM_PROFILES` entries already exist in `server/src/config.js`. This is step 72's work; it is recorded here so the reasoning is not re-derived.

### Cost after the change

The prompt grew, so input tokens per analysis grew with it. Measured over the eight v3 analyses: 28,391 input and 12,047 output tokens, **USD 0.0886 total, USD 0.0111 per analysis** at `claude-haiku-4-5` list pricing. v2 measured USD 0.0104 per analysis over four. Both are below the v1 figure of USD 0.0132, because v1's larger finding counts and one retry cost more output than the longer prompt costs input — the precision fix paid for itself.

### Model comparison with repeats (2026-09-21)

The prompt work above ended with a method problem, not an accuracy problem: one run per condition could not tell two prompts apart. So the next experiment fixed the measurement first — **three repeats of all four fixtures per condition, scored on spread as well as mean** — and then swept the model and the effort parameter together. 36 analyses, USD 0.77.

Three conditions. **A** is what ships today. **B** changes `ANTHROPIC_MODEL` and nothing else — the drop-in swap FR-3.14 says should never require editing the call site. **C** additionally raises `output_config.effort` to `high` and `max_tokens` to 16,000, testing the hypothesis recorded above that severity judgement would reward deeper reasoning.

| | A · haiku-4-5, effort n/a | B · sonnet-5, effort `low` | C · sonnet-5, effort `high` |
|---|---|---|---|
| Recall, high-severity | 100% *(stable)* | 100% *(stable)* | 100% *(stable)* |
| Precision, `fair_clauses_do_not_flag` | 66.7% *(spread 33.3–100%)* | 66.7% *(stable)* | **100%** *(stable)* |
| Precision, all findings | 74.7% *(68.2–83.3%)* | 75.2% *(70.6–80.0%)* | **79.2%** *(75.0–81.3%)* |
| Fixture 03 returns zero findings | yes *(stable)* | yes *(stable)* | **no — 1 finding in 1 of 3** |
| `overallRisk` correct, of 4 | 3.33 *(3–4)* | **4.00** *(stable)* | 3.67 *(3–4)* |
| Cost per analysis | USD 0.0095 | USD 0.0174 | USD 0.0371 |
| Mean / max duration | 13.0s / 24.0s | 10.1s / 17.1s | 29.4s / **40.5s** |

**The finding: `claude-sonnet-5` at the existing `effort: low` fixes the one thing two prompt revisions could not.** Risk correctness goes from 3.33 with a flapping document to **4.00, stable across three repeats**, and it does so as a pure configuration change — no code edit, no spec change, no `max_tokens` change. It is also *faster* than Haiku here (10.1s mean against 13.0s), because Haiku's larger, noisier finding lists cost more output tokens than Sonnet's reasoning costs.

**The hypothesis recorded above — that raising effort would help — is contradicted, and the reversal is worth stating plainly.** Effort `high` does buy precision: it is the only condition that never flags a fair clause, and it has the best broad precision. But it breaks two things the cheaper condition gets right:

- **It violates a hard gate.** SRS §10.4 requires fixture 03 to return *exactly* zero findings. Condition C returned one in a third of runs — a `LOW`/`IP` finding on the fragment "unless Client notifies Writer otherwise in writing". A deeper-reasoning model finds something to say about a clean contract.
- **`overallRisk` gets *worse*, not better** — 3.67 against B's 4.00, with fixture 02 flapping 2 of 3.
- **Latency would likely break FR-3.6 at the word cap.** C's slowest run was 40.5s on a ~900-word contract. `MAX_DOCUMENT_WORDS` is 4,000 — 4.4× longer — against a 60s `LLM_TIMEOUT_MS`. Condition C looks affordable only because these fixtures are short.

**Why the repeats earned their cost.** Condition A's fair-clause precision ranged from 33.3% to 100% across three identical runs. The single run recorded in the prompt-revision table above happened to land on 3/3, and was read at the time as "the precision fix worked". It did work in the aggregate — but that particular cell was luck, and a one-run gate would have enshrined it. This is the concrete instance of the reproducibility problem the previous section predicted.

**What remains broken, and why it is now tractable.** B still fails PRD §11.1's precision gate at 66.7%, so this does not unblock release. But the failure is no longer diffuse: it is *one clause*, fixture 04's "Fifty percent (50%) of the total fee is due upon execution… balance due within thirty (30) days of final delivery", flagged in **3 of 3** runs. The other two fair clauses are left alone in 3 of 3. A reproducible 3/3 failure is a target a prompt revision can be measured against — which is exactly what was missing when v2 and v3 were indistinguishable. Prompt iteration becomes worth resuming *after* the model change, not before it.

Worth noting that `analyze-v3` already contains the instruction this clause violates ("payment terms of net-30 or sooner, which are normal; … a deposit or upfront payment of any size"). Sonnet 5 at `effort: low` reads past it consistently; at `effort: high` it obeys it. So the next prompt revision's job is to make that rule un-missable at low effort, not to invent a new rule.

**Applied 2026-09-21.** `ANTHROPIC_MODEL=claude-sonnet-5`, with `output_config.effort` left at `low` and `max_tokens` at 4096 — no code or spec change. FR-3.14 gates a model change on the benchmark having been run; this is that run.

Verified through the real pipeline afterwards, not only through the sweep harness. The sweep built its own request parameters, so the production path for Sonnet 5 — which must *omit* `temperature` rather than send `0`, or every analysis fails with a 400 — had not actually been exercised. `buildMessageParams` with the resolved profile was checked to emit `{model: claude-sonnet-5, max_tokens: 4096, output_config: {effort: low}}` and no `temperature`, and then all four fixtures were run through `POST /documents` + `/analyze` on the real server:

| Fixture | Derived risk | Key | Model's own claim |
|---|---|---|---|
| 01 | HIGH | HIGH ✓ | HIGH |
| 02 | MEDIUM | MEDIUM ✓ | MEDIUM |
| 03 | LOW | LOW ✓ | LOW |
| 04 | HIGH | HIGH ✓ | HIGH |

4 of 4, reproducing condition B through the application rather than around it. Zero discarded findings, zero retries, slowest analysis 25.2s. Worth noting that `modelRisk` equalled the derived `overallRisk` on all four — under Haiku the two diverged on half the corpus, so the model's own judgement and FR-3.9's rule now agree.

Measured cost from those four `Analysis` rows: 16,653 input and 3,837 output tokens, **USD 0.0717 total, USD 0.0179 per analysis** — within 3% of the sweep's USD 0.0174, and the figure now quoted in the README.

**Next prompt target:** the deposit/net-30 false positive, which fails 3 of 3 and is therefore measurable, using this same three-repeat harness. Not done here.

### Reproducing this

Scoring remains provisional — step 72's `scripts/benchmark.js` formalises it, and this run was driven by a throwaway script rather than a committed one. The rules below are the ones that produced the numbers above, unchanged from what this section specified before the run:
- **Match rule:** a returned finding matches an expected one when, after `normalizeForMatch` (`server/src/services/verify.js`, the same normalisation the verifier uses, imported rather than copied), one excerpt contains the other.
- **Recall:** matched ÷ expected, over high-severity key findings only (7: five in 01, none in 02, two in 04). Recall over all severities reported alongside.
- **Precision:** both figures above — §11.1's `fair_clauses_do_not_flag` rate, and returned findings matching `findings` or `also_acceptable` ÷ all returned findings over 01, 02, 04.
- **Also record:** fixture 03's finding count, each document's derived `overallRisk` against the key, `discardedFindings`, token counts, and `retryCount`.

Note the finding field is `clauseExcerpt` in the API response and `excerpt` in the answer key; a scorer that assumes one name silently matches nothing.

---

## Test runs recorded for this check

| Suite | Result |
|---|---|
| server unit, full (`npm run test:unit`) | 488 passed |
| server integration, full (`npm run test:integration`) | 158 passed (includes the new fixture 06 route test) |
| server `npm run fixtures:verify` | OK: 18 excerpts verified, 3 fabricated confirmed absent |
| client unit, `analyzeErrors` + `AnalyzingPanel` | 23 passed |
| client e2e, `analyzing.spec.js` LLM_INVALID_OUTPUT + ALL_FINDINGS_DISCARDED | 2 passed |
| **2026-09-21** — accuracy run, fixtures 01–04 against the real provider (§8) | 4 analyses COMPLETED, 0 discarded findings, 1 retry |

## After the gate: Phase 1.5 is a gate, not a backlog

PRD §9 (and decision D6): Phase 1's definition of done proves the system *works*. It doesn't make the system operable, or lawful to point at real confidential documents. Missing today: email verification and password reset, per-user quotas and a spend ceiling, the retention job, provider retry and circuit breaker, dashboards and alerts, a rehearsed backup restore, and a published privacy policy, terms, and subprocessor list. **No public launch until step 75**, whatever happens to items 1 and 2 above — and §8's precision result is a second, independent reason not to rush it.
