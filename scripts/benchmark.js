/**
 * The accuracy benchmark (SRS §10.4, PRD §11.1) — BUILD-PLAN step 72, part 2.
 *
 * Runs the real analysis pipeline over the accepted fixtures and reports
 * recall, precision, per-document risk correctness, discard rate and cost,
 * then applies PRD §11.1's release gates and exits non-zero when one fails.
 *
 * WHY REPEATS ARE NOT OPTIONAL. Two runs of an identical prompt over
 * identical documents at temperature 0 were measured disagreeing with each
 * other — on which document's risk was wrong, on whether a fair clause was
 * flagged, and by several points of precision. A one-run gate flaps: it
 * blocks good changes and passes bad ones. Every gate here is therefore
 * applied to the WORST repeat, not to the mean (see evaluateGates).
 *
 * WHAT THIS DOES AND DOES NOT EXERCISE. It drives the real provider client,
 * so the §5.4 parameter profile for the configured model is exercised — the
 * failure where a model that rejects `temperature` receives it anyway is a
 * 400 on every analysis, and it is the kind of thing a benchmark that built
 * its own request parameters would miss. It does NOT touch Postgres or the
 * HTTP layer: persistence has no bearing on accuracy, and requiring a
 * database would make this unrunnable in the CI job that needs it.
 *
 * DRIFT RISK, STATED RATHER THAN HIDDEN. The retry-and-verify sequence below
 * mirrors runAnalysis() in server/src/services/analysis.js, which owns the
 * real one. It is duplicated because that function is coupled to the
 * database. If FR-3.2's retry behaviour changes there, change it here too.
 *
 * Usage:  node scripts/benchmark.js [--repeats N] [--fixtures a,b] [--no-history]
 */
import { readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

import config from "../server/src/config.js";
import { createLlmProvider } from "../server/src/services/llm/index.js";
import { PROMPT_VERSION } from "../server/src/prompts/analyze.js";
import { parseAnalysisResult } from "../server/src/schemas/analysisResult.js";
import { normalizeForMatch, verifyFindings } from "../server/src/services/verify.js";
import { deriveOverallRisk } from "../server/src/services/risk.js";
import { intakePastedText } from "../server/src/services/intake.js";
import { acceptedDocuments, scoreRepeat, spread, evaluateGates } from "./score.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "server", "tests", "fixtures");
const HISTORY = join(HERE, "benchmark-history.jsonl");

/** USD per million tokens, list price. Used only to report measured cost. */
const PRICING = Object.freeze({
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
});

/**
 * @param {readonly string[]} argv
 * @returns {{ repeats: number, fixtures: string[] | null, history: boolean }}
 */
function parseArgs(argv) {
  /** @type {{ repeats: number, fixtures: string[] | null, history: boolean }} */
  const args = { repeats: 3, fixtures: null, history: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repeats") args.repeats = Number(argv[(i += 1)]);
    else if (arg === "--fixtures") args.fixtures = String(argv[(i += 1)]).split(",");
    else if (arg === "--no-history") args.history = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.repeats) || args.repeats < 1)
    throw new Error("--repeats must be a positive integer");
  return args;
}

/**
 * One analysis. Mirrors runAnalysis()'s ordering: call, parse, ONE retry
 * with Appendix A's correction, verify every excerpt against the stored
 * text, then derive the risk from the survivors.
 */
async function analyze(provider, doc) {
  const startedAt = Date.now();
  let inputTokens = 0, outputTokens = 0, retryCount = 0, firstParseError = null;
  const addUsage = (r) => {
    inputTokens += r.inputTokens ?? 0;
    outputTokens += r.outputTokens ?? 0;
  };

  const first = await provider.analyze({ documentText: doc.rawText, requestId: "benchmark" });
  addUsage(first);
  let parsed = parseAnalysisResult(first.rawText);

  if (!parsed.success) {
    firstParseError = parsed.errorSummary;
    retryCount = 1;
    const second = await provider.analyze({
      documentText: doc.rawText,
      requestId: "benchmark",
      correction: { invalidResponse: first.rawText, errorSummary: parsed.errorSummary },
    });
    addUsage(second);
    parsed = parseAnalysisResult(second.rawText);
    if (!parsed.success)
      return { file: doc.file, status: "LLM_INVALID_OUTPUT", firstParseError, inputTokens, outputTokens, retryCount, elapsedMs: Date.now() - startedAt };
  }

  const result = parsed.data;
  const { verified, discardedCount } = verifyFindings(result.findings, normalizeForMatch(doc.rawText));
  if (result.findings.length > 0 && verified.length === 0)
    return { file: doc.file, status: "ALL_FINDINGS_DISCARDED", firstParseError, inputTokens, outputTokens, retryCount, elapsedMs: Date.now() - startedAt };

  return {
    file: doc.file,
    status: "COMPLETED",
    overallRisk: deriveOverallRisk(verified),
    modelRisk: result.overall_risk.toUpperCase(),
    findings: verified.map((f) => ({
      category: f.category.toUpperCase(),
      severity: f.severity.toUpperCase(),
      clauseExcerpt: f.clause_excerpt,
    })),
    missingClauses: result.missing_clauses,
    discardedFindings: discardedCount,
    firstParseError,
    inputTokens, outputTokens, retryCount,
    elapsedMs: Date.now() - startedAt,
  };
}

const pct = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
const band = (s, fmt) => (s === null ? "n/a" : s.stable ? `${fmt(s.mean)} (stable)` : `${fmt(s.mean)} (spread ${fmt(s.lo)} – ${fmt(s.hi)})`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8"));

  const selected = args.fixtures;
  let docs = acceptedDocuments(key);
  if (selected) docs = docs.filter((d) => selected.includes(d.file));
  if (docs.length === 0) throw new Error("no accepted fixtures selected");

  // The .txt form is used so the measurement isolates model accuracy from
  // PDF/DOCX extraction; fixtures:verify already proves the forms carry the
  // same excerpts. The text goes through the real FR-2.4 intake so the
  // excerpts are verified against exactly what production would store.
  const prepared = docs.map((d) => ({
    file: d.file,
    rawText: intakePastedText(readFileSync(join(FIXTURES, `${d.file}.txt`), "utf8")).rawText,
  }));

  if (config.LLM_PROVIDER !== "anthropic")
    console.warn(`WARNING: LLM_PROVIDER=${config.LLM_PROVIDER} — this measures the mock, not the model.\n`);

  // BUILD-PLAN D-F names a trap this script is in the right place to
  // catch: ANTHROPIC_MODEL changes, LLM_PRICE_* does not, and FR-5.3's
  // spend estimate silently meters the new model at the old price. A model
  // change is gated on this benchmark (FR-3.14), so the mismatch can be
  // caught at exactly the moment it is introduced. A warning rather than a
  // failure: list prices change, and a stale table here must never be able
  // to block a release on its own.
  const listed = PRICING[config.ANTHROPIC_MODEL];
  if (listed && (listed.input !== config.LLM_PRICE_INPUT_PER_MTOK || listed.output !== config.LLM_PRICE_OUTPUT_PER_MTOK)) {
    console.warn(
      `WARNING: LLM_PRICE_* does not match the list price recorded here for ${config.ANTHROPIC_MODEL}.\n` +
        `  configured: ${config.LLM_PRICE_INPUT_PER_MTOK} in / ${config.LLM_PRICE_OUTPUT_PER_MTOK} out per Mtok\n` +
        `  listed:     ${listed.input} in / ${listed.output} out per Mtok\n` +
        `  FR-5.3's spend estimate uses the configured values. Re-set them, or update this table if the price moved.\n`,
    );
  }

  console.log(`model ${config.ANTHROPIC_MODEL}  prompt ${PROMPT_VERSION}  effort ${config.llmParamProfile.effort ? "low" : "n/a"}`);
  console.log(`${prepared.length} document(s) x ${args.repeats} repeat(s)\n`);

  const provider = createLlmProvider(config);
  const repeats = [];
  const allRuns = [];

  for (let rep = 1; rep <= args.repeats; rep += 1) {
    const results = await Promise.all(prepared.map((d) => analyze(provider, d)));
    for (const r of results) {
      allRuns.push({ rep, ...r });
      console.log(
        `  r${rep} ${r.file.padEnd(30)} ${r.status.padEnd(22)} risk=${(r.overallRisk ?? "-").padEnd(6)} ` +
          `n=${String(r.findings?.length ?? "-").padStart(2)} miss=${String(r.missingClauses?.length ?? "-").padStart(2)} ` +
          `disc=${r.discardedFindings ?? "-"} retry=${r.retryCount} ${(r.elapsedMs / 1000).toFixed(1)}s`,
      );
    }
    const failed = results.filter((r) => r.status !== "COMPLETED");
    if (failed.length > 0)
      throw new Error(
        `repeat ${rep}: ${failed.length} analysis(es) did not complete — ` +
          failed.map((f) => `${f.file}: ${f.status}`).join("; ") +
          ". The corpus cannot be scored against a partial run.",
      );
    repeats.push(scoreRepeat(results, key));
  }

  const gates = evaluateGates(repeats);
  const recall = spread(repeats.map((r) => r.recall));
  const precision = spread(repeats.map((r) => r.precision));
  const broad = spread(repeats.map((r) => r.broadPrecision));
  const risk = spread(repeats.map((r) => r.riskCorrect));
  const discard = spread(repeats.map((r) => r.discardRate));

  const inputTokens = allRuns.reduce((s, r) => s + r.inputTokens, 0);
  const outputTokens = allRuns.reduce((s, r) => s + r.outputTokens, 0);
  const price = PRICING[config.ANTHROPIC_MODEL];
  const usd = price ? (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output : null;
  const retries = allRuns.reduce((s, r) => s + r.retryCount, 0);

  console.log("\nMETRICS (mean across repeats, with the range)");
  console.log(`  Recall, high-severity      ${band(recall, pct)}`);
  console.log(`  Precision, fair clauses    ${band(precision, pct)}`);
  console.log(`  Precision, all findings    ${band(broad, pct)}   [context only, not a gate]`);
  console.log(`  overallRisk correct        ${band(risk, (v) => `${v.toFixed(2)} of ${repeats[0].riskTotal}`)}`);
  console.log(`  Discard rate               ${band(discard, pct)}`);
  console.log(
    `  Cost                       ${usd === null ? "unpriced model" : `USD ${usd.toFixed(4)} total, ${(usd / allRuns.length).toFixed(4)}/analysis`}` +
      `   |  retries ${retries}/${allRuns.length}`,
  );

  console.log("\nRELEASE GATES (PRD §11.1, applied to the WORST repeat)");
  for (const g of gates) console.log(`  [${g.verdict.padEnd(7)}] ${g.name}\n            ${g.detail}`);

  /** @type {Array<[string, string[]]>} */
  const detail = [
    ["missed high-severity", repeats.flatMap((r) => r.missedHigh).map((m) => `${m.file}: ${m.why}`)],
    ["fair clauses flagged", repeats.flatMap((r) => r.flaggedFair).map((m) => `${m.file}: ${m.why}`)],
    ["wrong risk", repeats.flatMap((r) => r.riskWrong).map((m) => `${m.file}: expected ${m.expected}, got ${m.got}`)],
    ["noise on the clean contract", repeats.flatMap((r) => r.cleanNoise).map((m) => `${m.file} [${m.kind}] ${m.text}`)],
  ];
  for (const [heading, lines] of detail) {
    if (lines.length === 0) continue;
    console.log(`\n${heading.toUpperCase()} (${lines.length} across all repeats)`);
    for (const line of [...new Set(lines)]) console.log(`  - ${line}`);
  }

  const failing = gates.filter((g) => g.verdict === "FAIL");
  const warning = gates.filter((g) => g.verdict === "WARN");

  if (args.history) {
    let gitSha = null;
    try {
      gitSha = execSync("git rev-parse --short HEAD", { cwd: HERE, encoding: "utf8" }).trim();
    } catch {
      // Not a git checkout, or git unavailable. The row is still worth writing.
    }
    appendFileSync(
      HISTORY,
      JSON.stringify({
        ranAt: new Date().toISOString(),
        gitSha,
        model: config.ANTHROPIC_MODEL,
        promptVersion: PROMPT_VERSION,
        provider: config.LLM_PROVIDER,
        repeats: args.repeats,
        documents: prepared.map((d) => d.file),
        recall, precision, broadPrecision: broad, riskCorrect: risk, discardRate: discard,
        inputTokens, outputTokens, usd, retries,
        gates: gates.map((g) => ({ name: g.name, verdict: g.verdict, value: g.value })),
      }) + "\n",
      "utf8",
    );
    console.log(`\nAppended to ${HISTORY}`);
  }

  if (failing.length > 0) {
    console.error(`\nFAILED: ${failing.length} release gate(s) below PRD §11.1's blocking threshold.`);
    process.exitCode = 1;
    return;
  }
  console.log(warning.length > 0 ? `\nPASSED with ${warning.length} warning(s).` : "\nPASSED: every release gate met.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
