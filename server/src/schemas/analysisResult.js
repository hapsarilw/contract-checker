import { z } from "zod";

/**
 * SRS §5.2 — the LLM output contract (FR-3.2), transcribed.
 *
 * Two details are load-bearing and easy to lose:
 *   - .strict() on both objects, AnalysisResult and every Finding. Zod's
 *     default silently strips unknown keys; an unexpected key means the model
 *     has drifted from the contract, and stripping it hides that drift,
 *     whether the key is on the response or inside a finding. Never
 *     .passthrough() or .loose().
 *   - An upper bound on every string. A model that streams 40 KB into
 *     `explanation` fails validation instead of filling the database.
 */
export const Finding = z
  .object({
    category: z.enum([
      "payment",
      "ip",
      "scope",
      "termination",
      "liability",
      "confidentiality",
      "dispute",
      "other",
    ]),
    severity: z.enum(["low", "medium", "high"]),
    clause_excerpt: z.string().min(10).max(300),
    explanation: z.string().min(20).max(2000),
    suggested_change: z.string().min(10).max(2000),
  })
  .strict();

export const AnalysisResult = z
  .object({
    document_type: z.string().max(200),
    overall_risk: z.enum(["low", "medium", "high"]),
    summary: z.string().min(20).max(2000),
    findings: z.array(Finding).max(25),
    missing_clauses: z.array(z.string().max(500)).max(10),
  })
  .strict();

/** @typedef {z.infer<typeof Finding>} FindingData */
/** @typedef {z.infer<typeof AnalysisResult>} AnalysisResultData */

// Anchored at the start, so it is linear however much whitespace precedes it.
const LEADING_FENCE = /^\s*```[a-z]*[ \t]*\r?\n?/i;

const MAX_ISSUES_QUOTED = 10;
const MAX_ISSUE_LENGTH = 200;

/**
 * §5.2's defensive parse (FR-3.2). Returns the validated result, or a
 * summary of what failed for retryCorrection() (§2.2 step 6): a response
 * that isn't JSON and one that fails the schema both use the single retry.
 *
 * The only leniency is a leading or trailing markdown fence. The prompt
 * forbids fences, but spending the one retry on an otherwise valid fenced
 * response buys nothing. Prose around the JSON is not rescued: FR-3.1
 * forbids it, and extracting "the first {...}" would accept responses the
 * contract rejects. Stripping cannot alter a valid unfenced response, which
 * always starts with `{` and ends with `}`.
 *
 * @param {string} text
 * @returns {{ success: true, data: AnalysisResultData } | { success: false, errorSummary: string }}
 */
export function parseAnalysisResult(text) {
  let json;
  try {
    json = JSON.parse(stripMarkdownFence(text));
  } catch (err) {
    const message = /** @type {Error} */ (err).message;
    return { success: false, errorSummary: summarize([`not valid JSON (${message})`]) };
  }

  const result = AnalysisResult.safeParse(json);
  if (result.success) return { success: true, data: result.data };
  return { success: false, errorSummary: summarizeIssues(result.error.issues) };
}

/**
 * The trailing fence is removed with string operations rather than a
 * `...```\s*$` regex, which backtracks quadratically over a long run of
 * whitespace that is not followed by a fence.
 *
 * @param {string} text
 */
function stripMarkdownFence(text) {
  const body = text.replace(LEADING_FENCE, "");
  const trimmed = body.trimEnd();
  return trimmed.endsWith("```") ? trimmed.slice(0, -3) : body;
}

/**
 * Zod 4 keeps running a field's checks after its type check fails, so an
 * array field given a string also reports "expected string to have <=25
 * characters". That sibling issue is dropped: this summary is sent back to
 * the model as its correction, and a misleading instruction can waste the
 * only retry.
 *
 * @param {ReadonlyArray<{ code: string, path: PropertyKey[], message: string }>} issues
 */
function summarizeIssues(issues) {
  const wrongTypePaths = new Set(
    issues
      .filter((issue) => issue.code === "invalid_type")
      .map((issue) => pathLabel(issue.path)),
  );
  const lines = issues
    .filter(
      (issue) =>
        issue.code === "invalid_type" || !wrongTypePaths.has(pathLabel(issue.path)),
    )
    .map((issue) => `${pathLabel(issue.path)}: ${issue.message}`);
  return summarize(lines);
}

/** @param {PropertyKey[]} path */
function pathLabel(path) {
  return path.length === 0 ? "response" : path.map(String).join(".");
}

/**
 * Bounded because parts of it are model-controlled — an unrecognized key
 * name can be any length — and the whole correction is billed as input on
 * the retry. No trailing period: retryCorrection()'s template supplies it.
 *
 * @param {string[]} lines
 */
function summarize(lines) {
  const quoted = lines
    .slice(0, MAX_ISSUES_QUOTED)
    .map((line) =>
      line.length > MAX_ISSUE_LENGTH
        ? `${line.slice(0, MAX_ISSUE_LENGTH)} [truncated]`
        : line,
    );
  const unquoted = lines.length - quoted.length;
  const summary = quoted.join("; ") + (unquoted > 0 ? `; and ${unquoted} more` : "");
  return summary.replace(/[.\s]+$/, "");
}
