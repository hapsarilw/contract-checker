# ClauseCheck test fixtures

Eight documents plus an answer key, covering every intake path and analysis outcome in SRS §10, and one long report for the interface.

All contracts are synthetic. They are written to be realistic in shape and language, but no real party, company, or agreement is involved — which is the point: every clause is known in advance, so "did the analyzer get it right" is a checkable question rather than a judgement call.

## Files

| File | Formats | Words | Intake | What it exercises |
|---|---|---|---|---|
| `01-design-services-hostile` | docx, pdf, txt | 980 | accept | 5 high / 1 medium / 1 low → server rule derives **high** |
| `02-dev-retainer-moderate` | docx, pdf, txt | 849 | accept | no highs → derives **medium** |
| `03-copywriting-clean` | docx, pdf, txt | 895 | accept | **zero findings**, zero missing protections |
| `04-video-production-mixed` | docx, pdf, txt | 876 | accept | bad and fair clauses in one document |
| `05-oversized-msa` | docx, pdf, txt | 4,468 | reject | `DOCUMENT_TOO_LONG` (FR-2.6) |
| `06-scanned-no-text-layer` | pdf | 0 | reject | `DOCUMENT_TOO_SHORT` — rasterised, no text layer (FR-2.5) |
| `07-too-short` | txt | 38 | reject | `DOCUMENT_TOO_SHORT` via paste path |
| `08-not-really-a-pdf` | pdf | — | reject | `UNSUPPORTED_FILE_TYPE` — magic bytes `46 52 45 45`, not `%PDF` (FR-2.3) |
| `13-stress-long-report` | json | — | — | a 12-finding report for the long-report screen (see below) |
| `expected.json` | — | — | — | the answer key |

Each contract ships as `.docx`, `.pdf`, and `.txt` built from identical source text, so a discrepancy between formats is an extraction bug in your pipeline, not a difference in the documents.

Word counts are `countWords` over the `.txt`, the way intake computes them. The same document uploaded as a PDF counts five words more per page, because pdf-parse (the production extractor) appends a `-- n of N --` marker to each page's text.

Fixtures 09–12 in SRS §11.1 are Phase 1.5 and are not built yet.

## The answer key

`expected.json` gives, per document: expected intake outcome, expected `overall_risk` under the FR-3.9 server rule, and every finding with its category, severity, and **verbatim excerpt**.

Three fields matter more than they look:

- **`fair_clauses_do_not_flag`** (fixture 04) — clauses that are genuinely good. Fixture 04 deliberately puts IP-transfers-on-payment and a two-round revision limit next to an unlimited-reshoot clause and a punitive late-delivery penalty. Flagging the good ones is a false positive and a test failure. Precision is measurable here, not just recall.
- **`also_acceptable`** (fixture 02) — a clause where flagging it low is defensible and missing it is not an error. Keeps the benchmark honest instead of pretending every judgement is binary.
- **`fabricated_excerpts`** — three excerpts that must always be discarded by FR-3.3. One is invented outright, one is lifted from a different fixture, and one is a **paraphrase of a real clause** with the parentheses dropped from "sixty (60)". That third case documents the deliberate strictness of the §5.3 matcher: near-miss tolerance is exactly the hole a paraphrasing model slips through.

Three details of its shape to respect in any code that reads it:

- `fabricated_excerpts` is a **top-level** array, each entry naming its document in `against`. It is not nested under `documents`; code that looks for it there finds nothing and passes vacuously.
- `also_acceptable` entries have the full finding shape (`category`, `severity`, `excerpt`, `why`); `fair_clauses_do_not_flag` entries have only `excerpt` and `why`.
- Documents carry prose-only fields next to the data — `note`, `findings_note`, `missing_note`, `fair_note` — and a schema over the file must allow them.

## Fixture 03 is the important one

A clean contract is the state most projects never test. Fixture 03 contains all eight standard protections from the missing-clauses checklist, so the correct output is an empty findings array *and* an empty missing-clauses array.

Two failures it catches that nothing else will: a model that invents problems to look useful, and the zero-findings report screen, which usually gets built last and looks like an error state.

## Fixture 13 is a report, not a document

The interface prototype (`docs/design/ClauseCheck.html`) shows a 12-finding report for its "long report" case, which it numbered 09. SRS §11.1 assigns 09 to `09-injection-attempt`, so here it is 13 (BUILD-PLAN decision D-E).

`13-stress-long-report.json` is shaped like the response of `GET /api/v1/documents/:id`: the document and its analysis, findings sorted high to low, `overallRisk` derived by the server rule. Its twelve excerpts are clauses from fixtures 01, 04 and 02, referenced through `contracts.js` rather than restated. It is not in `expected.json`, because it is a report to render, not a document to analyse.

Two things differ from the prototype: its glossary markup (`[[term|text]]`) is reduced to plain text, as the API returns plain strings, and its summary says "seven marked high" where the prototype said "three", which contradicted its own seven high findings.

## Verified

```bash
npm run fixtures:verify
```

`verify-fixtures.js` is the SRS §11.3 generation constraint as a script, not a claim in this file: it imports `normalizeForMatch` and `excerptAppears` from `src/services/verify.js` (never a copy — a stale copy keeps passing after the real matcher changes), and gets each document's text through `intakeUpload`/`intakePastedText`, the same two entry points production calls. That means the PDF side comes from pdf-parse, the extractor SRS §9 names for production, not pdftotext — pdftotext proves an excerpt survives *a* extractor, not the one production runs.

Every excerpt that `findings`, `also_acceptable`, or `fair_clauses_do_not_flag` claims is real text of its document is checked against both the `.txt` and the PDF-extracted form; all three `fabricated_excerpts` are checked to be absent from both. A run currently reports:

```
OK: 18 excerpt(s) verified across 3 document(s), each in txt and pdf form; 3 fabricated excerpt(s) confirmed absent.
```

18, not 30 — fixture 03 contributes zero by design (its `findings` array is empty on purpose, see above), and only 01, 02, and 04 have excerpts to check. The 12 excerpts of fixture 13 are checked separately, in `build.js` at generation time, since 13 is not in `expected.json`.

Exits non-zero on the first mismatch, naming the document, the format, and the excerpt — verified by corrupting an excerpt in `expected.json`, planting a fabricated excerpt as a real finding, editing the clause text in `contracts.js` out from under its answer key, and falsely marking a real clause as fabricated. All four are caught; none is wired into CI yet (step 70).

Two things this script deliberately does NOT do, both intentional:

- It never compares PDF bytes. PDFs built by `build.js` are pinned to a fixed date and so happen to be byte-identical across rebuilds, but this script would still be correct if they weren't — it only ever compares text extracted through the real pipeline, because that is what a match against `Document.rawText` at runtime actually depends on.
- The document side of every comparison already has curly quotes folded to straight by `normalize()` (FR-2.4) before this script's `excerptAppears` call ever sees it — the same folding production applies before storing `Document.rawText`. So this corpus's typographic apostrophes (U+2019) exercise `normalizeForMatch`'s curly-quote branch only from the excerpt side. That's by design: SRS §10.5's 100% branch coverage on `verify.js` comes from TR-3's unit tests, which drive both sides directly, not from this corpus.

## Regenerating

```bash
node build.js
```

`contracts.js` defines each flagged clause once, in a body array of `['h', text]` / `['p', text]` tuples. For every contract, `build.js`:

- builds the `.docx` with the `docx` package (a pure JS library — reproducible in CI, unlike the `soffice --headless` process this corpus used to rely on);
- writes the `.txt` by reading that `.docx` back with mammoth, the extractor production uses, so the `.txt` is the `.docx` as the pipeline reads it;
- builds the `.pdf` with `pdfkit` from the same body array, and fails unless its text, read back with pdf-parse, holds the same characters in the same order as the `.docx`'s;
- fails unless production's type detection recognises the `.docx` and the `.pdf`.

It also writes `07-too-short.txt`, `08-not-really-a-pdf.pdf` (and fails unless it starts with `46 52 45 45` and type detection rejects it) and `13-stress-long-report.json`, and fails if `06-scanned-no-text-layer.pdf` is missing, since a rasterised scan cannot be generated from text.

Every generated file is pinned to a fixed date, so rebuilding unchanged sources writes byte-identical files. If `git status` shows a fixture changed after `node build.js`, its source changed.
