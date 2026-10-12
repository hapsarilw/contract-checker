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

/**
 * BUILD-PLAN step 64: the analyze errors with no prototype copy, written in
 * its voice (name the problem, then the next step, NFR-4.3). They are
 * functions rather than frozen copy because each depends on something
 * only known at the time: the server's own words, or today's date.
 *
 * `action` says what the primary button does. "retry" re-runs analyze on
 * the same document. "reports" goes to the saved reports instead, for the
 * cases where retrying now cannot work and offering it would only send
 * the person back into the same failure.
 *
 * @typedef {{ code: string, title: string, body: string, primary: string, action?: "retry" | "reports" }} AnalyzeErrorCopy
 * @type {Record<string, (apiError: { code: string, message: string }, now: Date) => AnalyzeErrorCopy>}
 */
const DYNAMIC = {
  // FR-7.10's two degraded-mode codes. The upload screen also turns them
  // into a standing banner (degraded.js); this is the card for the attempt
  // that discovered it.
  LLM_UNAVAILABLE: () => ({
    code: "LLM_UNAVAILABLE · 503",
    title: "Checking is paused for a moment.",
    body: "The service that reads contracts isn’t answering, so we stopped rather than keep you waiting. Your contract is saved and your earlier reports are all still here. Try this one again in a minute or two.",
    primary: "See your saved reports",
    action: "reports",
  }),
  // The server's message is used as the body, not replaced: it says
  // different, true things for a spend ceiling and for an operator's pause
  // (FR-5.4), and a client that flattened them would be the one lying.
  SPEND_LIMIT_REACHED: (apiError) => ({
    code: "SPEND_LIMIT_REACHED · 503",
    title: "Checking is paused for now.",
    body: `${apiError.message} Your contract is saved and your earlier reports are all still here.`,
    primary: "See your saved reports",
    action: "reports",
  }),
  QUOTA_EXCEEDED: (_apiError, now) => ({
    code: "QUOTA_EXCEEDED · 429",
    title: "You’ve used this month’s checks.",
    body: `Your allowance resets on ${formatResetDate(now)}. Your contract is saved, so you can check it then, and every report you already have is still here.`,
    primary: "See your saved reports",
    action: "reports",
  }),
  // The hourly limit: the server's message carries the real number.
  RATE_LIMITED: (apiError) => ({
    code: "RATE_LIMITED · 429",
    title: "That’s a lot of checks in one hour.",
    body: `${apiError.message} Your contract is saved; come back to it once the hour has passed.`,
    primary: "See your saved reports",
    action: "reports",
  }),
  // Step 75: the database cannot be reached. Not a degraded-mode code
  // (degraded.js): the banner promises that saved reports are still
  // there, and during a database outage they cannot be opened either.
  // The contract itself was saved before the outage, or this screen
  // would not have a document to check.
  DATABASE_UNAVAILABLE: () => ({
    code: "DATABASE_UNAVAILABLE · 503",
    title: "We can’t reach your saved work right now.",
    body: "Nothing has been lost. Your contract and your reports are safe; we just can’t open them for a moment. Try again in a minute.",
    primary: "Try again",
    action: "retry",
  }),
  // On the analyze route SERVER_BUSY has one cause: the analyze limiter
  // failing CLOSED because its store (Redis) is down (FR-5.6). Until step 75
  // this card said "too many checks are running at once... a few seconds",
  // which was never true of it. The server's message is the body now: it
  // says why, and that saved reports still open (failurePolicyStore.js).
  SERVER_BUSY: (apiError) => ({
    code: "SERVER_BUSY · 503",
    title: "Checking a contract is paused for a moment.",
    body: apiError.message,
    primary: "Try again",
    action: "retry",
  }),
};

/**
 * The first day of the next UTC month, formatted exactly as the server
 * formats it in its own QUOTA_EXCEEDED message (services/quota.js), so
 * the two can never name different days. UTC because the quota period is
 * a UTC month (periodOf).
 *
 * @param {Date} now
 */
export function formatResetDate(now) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Every code this module has copy for, the static ones and the dynamic
 * ones. Tests walk it to check that each names a next step.
 */
export const MAPPED_ANALYZE_CODES = Object.freeze([
  ...Object.keys(ANALYZE_ERRORS),
  ...Object.keys(DYNAMIC),
]);

const FALLBACK = Object.freeze({
  title: "Something went wrong.",
  primary: "Try again",
});

/**
 * @param {{ code: string, message: string }} apiError
 * @param {Date} [now]
 * @returns {AnalyzeErrorCopy}
 */
export function resolveAnalyzeError(apiError, now = new Date()) {
  const known = ANALYZE_ERRORS[apiError.code];
  if (known) return { ...known, action: "retry" };
  const dynamic = DYNAMIC[apiError.code];
  if (dynamic) return dynamic(apiError, now);
  // Any other code: a validation error, a 500, NETWORK_ERROR from
  // api/client.js. The document already exists and the user still needs
  // somewhere to go; the server's own message names the next step
  // (NFR-4.3 applies to every entry in its error table).
  return {
    code: apiError.code,
    title: FALLBACK.title,
    body: apiError.message,
    primary: FALLBACK.primary,
    action: "retry",
  };
}
