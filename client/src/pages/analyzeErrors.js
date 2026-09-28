/**
 * BUILD-PLAN step 34 — the prototype's ANALYZE_ERRORS map
 * (docs/design/ClauseCheck.html), mapped to the real server codes. All
 * of these are static copy: unlike uploadErrors.js's DOCUMENT_TOO_LONG/
 * DOCUMENT_TOO_SHORT, none of the prototype's wording here bakes in a
 * fabricated number that needs a real one substituted, so the prototype's
 * copy is used verbatim (step 34: "with its exact copy") — except one.
 *
 * ANALYSIS_IN_PROGRESS is the exception, and deliberately so: the
 * prototype's "Give it about 30 seconds" assumes the other request is
 * genuinely still running. FR-3.8's partial-unique-index guard returns
 * this SAME 409 for that case AND for a crashed request that left a
 * stale PENDING row — indistinguishable from the response alone — and a
 * stale row isn't cleared until the reaper notices it (every minute,
 * SRS §12.3) past its 5-minute staleness threshold (FR-3.8), up to
 * about 6 minutes worst case. Promising 30 seconds when the real wait
 * could be 6 minutes is exactly the false precision FR-7.4 elsewhere
 * bars — step 34 calls this out by name, so this file's ANALYSIS_IN_
 * PROGRESS entry states the range instead of the prototype's single
 * optimistic number.
 */
export const ANALYZE_ERRORS = Object.freeze({
  LLM_INVALID_OUTPUT: Object.freeze({
    code: "LLM_INVALID_OUTPUT · 502",
    title: "The check didn’t finish.",
    body: "The analysis service returned something we couldn’t read, twice. Your document wasn’t affected and nothing was shared — try again in a minute.",
    primary: "Try again",
  }),
  LLM_TIMEOUT: Object.freeze({
    code: "LLM_TIMEOUT · 504",
    title: "This took longer than expected, so we stopped.",
    body: "Your contract is still here. Try again — and if it happens a second time, pasting the text usually gets through where a file doesn’t.",
    primary: "Try again",
  }),
  ALL_FINDINGS_DISCARDED: Object.freeze({
    code: "ALL_FINDINGS_DISCARDED · 502",
    title: "We couldn’t verify any of what came back.",
    body: "Every clause the check flagged failed our word-for-word match against your document, so we threw them all away rather than show you quotes that might not be in your contract. This is rare — trying again usually works. It does not mean your contract is clean.",
    primary: "Try again",
  }),
  ANALYSIS_IN_PROGRESS: Object.freeze({
    code: "ANALYSIS_IN_PROGRESS · 409",
    title: "This contract is already being checked.",
    body: "Another check on the same document is running — that usually finishes in about 30 seconds. If the earlier attempt crashed instead of finishing, though, it can take up to about 6 minutes before our system notices and clears it, and you’re able to try again.",
    primary: "Wait for it",
  }),
  EMAIL_NOT_VERIFIED: Object.freeze({
    code: "EMAIL_NOT_VERIFIED · 403",
    title: "Confirm your email to run a check.",
    body: "Your contract is uploaded and safe. Checks start once your email address is confirmed: open the link we sent when you signed up, or go back to the upload page to have it sent again. Already confirmed it? Try again.",
    primary: "Try again",
  }),
});

const FALLBACK = Object.freeze({
  title: "Something went wrong.",
  primary: "Try again",
});

/**
 * @param {{ code: string, message: string }} apiError
 * @returns {{ code: string, title: string, body: string, primary: string }}
 */
export function resolveAnalyzeError(apiError) {
  const known = ANALYZE_ERRORS[apiError.code];
  if (known) return known;
  // Any other code — a validation error, a 500, NETWORK_ERROR from
  // api/client.js — not one of the four this step maps, but the
  // document already exists and the user still needs somewhere to go.
  return {
    code: apiError.code,
    title: FALLBACK.title,
    body: apiError.message,
    primary: FALLBACK.primary,
  };
}
