# ClauseCheck test fixtures

Eight documents plus an answer key, covering every intake path and analysis outcome in SRS §10.

All contracts are synthetic. They are written to be realistic in shape and language, but no real party, company, or agreement is involved — which is the point: every clause is known in advance, so "did the analyzer get it right" is a checkable question rather than a judgement call.

## Files

| File | Formats | Words | Intake | What it exercises |
|---|---|---|---|---|
| `01-design-services-hostile` | docx, pdf, txt | 981 | accept | 5 high / 1 medium / 1 low → server rule derives **high** |
| `02-dev-retainer-moderate` | docx, pdf, txt | 849 | accept | no highs → derives **medium** |
| `03-copywriting-clean` | docx, pdf, txt | 895 | accept | **zero findings**, zero missing protections |
| `04-video-production-mixed` | docx, pdf, txt | 876 | accept | bad and fair clauses in one document |
| `05-oversized-msa` | docx, pdf, txt | 4,468 | reject | `DOCUMENT_TOO_LONG` (FR-2.6) |
| `06-scanned-no-text-layer` | pdf | 0 | reject | `DOCUMENT_TOO_SHORT` — rasterised, no text layer (FR-2.5) |
| `07-too-short` | txt | 38 | reject | `DOCUMENT_TOO_SHORT` via paste path |
| `08-not-really-a-pdf` | pdf | — | reject | `UNSUPPORTED_FILE_TYPE` — magic bytes `46 52 45 45`, not `%PDF` (FR-2.3) |
| `expected.json` | — | — | — | the answer key |

Each contract ships as `.docx`, `.pdf`, and `.txt` generated from identical source text, so a discrepancy between formats is an extraction bug in your pipeline, not a difference in the documents.

## The answer key

`expected.json` gives, per document: expected intake outcome, expected `overall_risk` under the FR-3.9 server rule, and every finding with its category, severity, and **verbatim excerpt**.

Three fields matter more than they look:

- **`fair_clauses_do_not_flag`** (fixture 04) — clauses that are genuinely good. Fixture 04 deliberately puts IP-transfers-on-payment and a two-round revision limit next to an unlimited-reshoot clause and a punitive late-delivery penalty. Flagging the good ones is a false positive and a test failure. Precision is measurable here, not just recall.
- **`also_acceptable`** (fixture 02) — a clause where flagging it low is defensible and missing it is not an error. Keeps the benchmark honest instead of pretending every judgement is binary.
- **`fabricated_excerpts`** — three excerpts that must always be discarded by FR-3.3. One is invented outright, one is lifted from a different fixture, and one is a **paraphrase of a real clause** with the parentheses dropped from "sixty (60)". That third case documents the deliberate strictness of the §5.3 matcher: near-miss tolerance is exactly the hole a paraphrasing model slips through.

## Fixture 03 is the important one

A clean contract is the state most projects never test. Fixture 03 contains all eight standard protections from the missing-clauses checklist, so the correct output is an empty findings array *and* an empty missing-clauses array.

Two failures it catches that nothing else will: a model that invents problems to look useful, and the zero-findings report screen, which usually gets built last and looks like an error state.

## Verified

Every excerpt in the answer key was checked against the shipped documents using the exact `normalizeForMatch` algorithm from SRS §5.3:

- 21/21 excerpt checks pass against the `.txt` source
- 18/18 pass against text extracted from the `.pdf` files with `pdftotext`
- all three fabricated excerpts correctly absent

The PDF check matters because it proves the excerpts survive real extraction. If your pipeline discards a finding from fixture 01 or 04, the bug is in your normalisation (FR-2.4), not in the fixture.

Note that the contracts use typographic apostrophes (`'`). This is deliberate — it exercises the curly-quote path in §5.3, which is the most likely cause of a legitimate finding being silently discarded.

## Regenerating

`contracts.js` defines each flagged clause once and both the document builder and the answer key reference it, so the excerpts cannot drift out of sync with the text. If you edit a clause, rebuild both:

```bash
node build.js && node expected.js   # expected.js exits non-zero if any excerpt no longer matches
soffice --headless --convert-to pdf *.docx
```
