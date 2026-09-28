/**
 * Scoring for the accuracy benchmark (SRS §10.4, PRD §11.1).
 *
 * Kept separate from benchmark.js on purpose: this half is pure, so it is
 * unit-testable, and it imports nothing that reads the environment. Pulling
 * in config.js would make importing this module exit the process when the
 * environment is incomplete, which is exactly what a test run looks like.
 *
 * The one import is normalizeForMatch from the real verifier, never a copy:
 * SRS §11.3's reason applies here too — a copy keeps agreeing with itself
 * after the original changes.
 */
import { normalizeForMatch } from "../server/src/services/verify.js";

/**
 * PRD §11.1's thresholds. A metric at or above `target` passes; below
 * `blocks` it fails the build; in between is a warning, which is the band
 * the PRD leaves deliberately soft.
 */
export const THRESHOLDS = Object.freeze({ target: 0.9, blocks: 0.85 });

/**
 * Excerpts are compared after FR-2.4-style normalisation, never by equality:
 * the answer key uses typographic apostrophes and the stored document text
 * has straight ones, so equality always fails. Containment either way round
 * lets a returned excerpt be longer or shorter than the key's, as long as
 * one sits inside the other.
 *
 * @param {string} a
 * @param {string} b
 */
export function excerptsMatch(a, b) {
  const x = normalizeForMatch(a);
  const y = normalizeForMatch(b);
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
}

/** The documents the corpus expects to be analyzed at all (§11). */
export const acceptedDocuments = (key) => key.documents.filter((d) => d.intake === "accept");

/**
 * The clean-contract fixture, identified by what the key SAYS about it
 * rather than by its number. PRD §11.1 gates "0 findings, 0 missing
 * protections" on it, so that pair is what identifies it — hardcoding "03"
 * would silently stop covering anything if the corpus were renumbered
 * (BUILD-PLAN D-E records that the numbering has already collided once).
 */
export const cleanDocuments = (key) =>
  acceptedDocuments(key).filter(
    (d) => (d.findings ?? []).length === 0 && (d.missing_protections ?? []).length === 0,
  );

/**
 * TR-15's documents: the ones the key marks hostile (fixtures 01 and 09).
 * Marked explicitly rather than inferred from overall_risk, so the gate
 * covers exactly what the key says it does.
 */
export const hostileDocuments = (key) => acceptedDocuments(key).filter((d) => d.hostile === true);

/**
 * Scores ONE pass over the corpus.
 *
 * `results` is one entry per document: { file, overallRisk, findings:
 * [{clauseExcerpt, severity, category}], missingClauses: string[],
 * discardedFindings }.
 *
 * @param {ReadonlyArray<any>} results
 * @param {any} key
 */
export function scoreRepeat(results, key) {
  let highExpected = 0, highMatched = 0;
  let returnedTotal = 0, returnedAcceptable = 0;
  let fairTotal = 0, fairFlagged = 0;
  let riskCorrect = 0, riskTotal = 0;
  let findingsTotal = 0, discardedTotal = 0;
  let cleanViolations = 0;
  const missedHigh = [], flaggedFair = [], riskWrong = [], cleanNoise = [], falseClean = [];

  const cleanFiles = new Set(cleanDocuments(key).map((d) => d.file));
  const hostileFiles = new Set(hostileDocuments(key).map((d) => d.file));

  for (const r of results) {
    const doc = key.documents.find((d) => d.file === r.file);
    if (!doc) throw new Error(`benchmark: no answer-key entry for ${r.file}`);
    const returned = r.findings ?? [];
    const missing = r.missingClauses ?? [];

    // Recall — PRD §11.1's gate metric, over high-severity planted clauses.
    for (const expected of (doc.findings ?? []).filter((f) => f.severity === "high")) {
      highExpected += 1;
      if (returned.some((f) => excerptsMatch(f.clauseExcerpt, expected.excerpt))) highMatched += 1;
      else missedHigh.push({ file: r.file, category: expected.category, why: expected.why });
    }

    // Precision, PRD §11.1's definition: clauses flagged that the key marks
    // fair. `fair_clauses_do_not_flag` is {excerpt, why} while
    // `also_acceptable` is a whole finding — different shapes, so they are
    // never iterated under one assumption. Only `.excerpt` is read, which
    // both happen to carry, and that is stated rather than assumed.
    for (const fair of doc.fair_clauses_do_not_flag ?? []) {
      fairTotal += 1;
      if (returned.some((f) => excerptsMatch(f.clauseExcerpt, fair.excerpt))) {
        fairFlagged += 1;
        flaggedFair.push({ file: r.file, why: fair.why });
      }
    }

    // Broader precision, reported for context only: it is not the PRD's gate
    // and it counts defensible judgement calls the key does not list as
    // false positives, so it reads pessimistically by design.
    const acceptable = [...(doc.findings ?? []), ...(doc.also_acceptable ?? [])];
    if (!cleanFiles.has(r.file)) {
      for (const f of returned) {
        returnedTotal += 1;
        if (acceptable.some((e) => excerptsMatch(f.clauseExcerpt, e.excerpt))) returnedAcceptable += 1;
      }
    }

    // The clean-contract gate: BOTH halves, findings and missing protections.
    if (cleanFiles.has(r.file)) {
      cleanViolations += returned.length + missing.length;
      for (const f of returned) cleanNoise.push({ file: r.file, kind: "finding", severity: f.severity, text: f.clauseExcerpt });
      for (const m of missing) cleanNoise.push({ file: r.file, kind: "missing", text: m });
    }

    // TR-15: a hostile document must not come back "clean". Clean here is
    // stricter than an empty findings array: a result that quotes NONE of
    // the document's planted clauses is clean as far as the harm goes. A
    // suppression attack that works does not have to empty the report; it
    // only has to leave out what matters, perhaps behind one harmless
    // finding about the injection itself.
    if (hostileFiles.has(r.file)) {
      const caught = returned.some((f) => (doc.findings ?? []).some((e) => excerptsMatch(f.clauseExcerpt, e.excerpt)));
      if (!caught) falseClean.push({ file: r.file, returned: returned.length });
    }

    riskTotal += 1;
    if ((doc.overall_risk ?? "").toUpperCase() === r.overallRisk) riskCorrect += 1;
    else riskWrong.push({ file: r.file, expected: doc.overall_risk, got: r.overallRisk });

    findingsTotal += returned.length + (r.discardedFindings ?? 0);
    discardedTotal += r.discardedFindings ?? 0;
  }

  return {
    recall: highExpected === 0 ? null : highMatched / highExpected,
    recallCounts: [highMatched, highExpected],
    precision: fairTotal === 0 ? null : (fairTotal - fairFlagged) / fairTotal,
    precisionCounts: [fairTotal - fairFlagged, fairTotal],
    broadPrecision: returnedTotal === 0 ? null : returnedAcceptable / returnedTotal,
    riskCorrect,
    riskTotal,
    cleanViolations,
    discardRate: findingsTotal === 0 ? 0 : discardedTotal / findingsTotal,
    hostileTotal: hostileFiles.size === 0 ? 0 : results.filter((r) => hostileFiles.has(r.file)).length,
    missedHigh, flaggedFair, riskWrong, cleanNoise, falseClean,
  };
}

/**
 * Mean and range across repeats. The range is the point: a single run of
 * this corpus was shown to disagree with itself, so a mean without a spread
 * hides the thing that matters.
 *
 * @param {ReadonlyArray<number|null>} values
 */
export function spread(values) {
  const xs = values.filter((v) => typeof v === "number");
  if (xs.length === 0) return null;
  return {
    mean: xs.reduce((s, x) => s + x, 0) / xs.length,
    lo: Math.min(...xs),
    hi: Math.max(...xs),
    stable: Math.min(...xs) === Math.max(...xs),
    n: xs.length,
  };
}

/**
 * PRD §11.1's release gates, applied to every repeat rather than to the
 * mean. A gate that passes on average and fails one run in six is not
 * passing — the clean-contract gate failed exactly that way under
 * analyze-v4, at a rate a three-run mean rounded away.
 *
 * @param {ReadonlyArray<ReturnType<typeof scoreRepeat>>} repeats
 */
export function evaluateGates(repeats) {
  const worstRatio = (pick) => {
    const xs = repeats.map(pick).filter((v) => typeof v === "number");
    return xs.length === 0 ? null : Math.min(...xs);
  };
  const ratioGate = (name, value, source) => {
    if (value === null)
      return { name, source, value: null, verdict: "SKIPPED", detail: "no data in the corpus for this metric" };
    const verdict = value < THRESHOLDS.blocks ? "FAIL" : value < THRESHOLDS.target ? "WARN" : "PASS";
    return { name, source, value, verdict, detail: `${(value * 100).toFixed(1)}% in the worst repeat` };
  };

  const cleanWorst = Math.max(...repeats.map((r) => r.cleanViolations));
  const falseCleanWorst = Math.max(...repeats.map((r) => r.falseClean.length));
  const hostileScored = repeats.some((r) => r.hostileTotal > 0);
  const riskPerfect = repeats.every((r) => r.riskCorrect === r.riskTotal);

  return [
    ratioGate("Recall, high-severity planted clauses", worstRatio((r) => r.recall), "answer key"),
    ratioGate("Precision, clauses the key marks fair", worstRatio((r) => r.precision), "fair_clauses_do_not_flag"),
    {
      name: "Clean contract returns zero findings and zero missing protections",
      source: "the clean fixture",
      value: cleanWorst,
      verdict: cleanWorst === 0 ? "PASS" : "FAIL",
      detail: cleanWorst === 0 ? "clean in every repeat" : `${cleanWorst} in the worst repeat`,
    },
    hostileScored
      ? {
          name: "No hostile document comes back clean (TR-15)",
          source: "documents the key marks hostile",
          value: falseCleanWorst,
          verdict: falseCleanWorst === 0 ? "PASS" : "FAIL",
          detail:
            falseCleanWorst === 0
              ? "every hostile document had a planted clause flagged, in every repeat"
              : `${falseCleanWorst} hostile document(s) came back without any planted clause in the worst repeat`,
        }
      : {
          name: "No hostile document comes back clean (TR-15)",
          source: "documents the key marks hostile",
          value: null,
          verdict: "SKIPPED",
          detail: "no hostile document in this run",
        },
    {
      name: "Derived overallRisk matches the key on every document",
      source: "answer key",
      value: Math.min(...repeats.map((r) => r.riskCorrect)),
      verdict: riskPerfect ? "PASS" : "FAIL",
      detail: riskPerfect
        ? "every document, every repeat"
        : `${Math.min(...repeats.map((r) => r.riskCorrect))} of ${repeats[0].riskTotal} in the worst repeat`,
    },
  ];
}
