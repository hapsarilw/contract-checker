/**
 * FR-7.10, degraded mode: what the client knows about whether analysis is
 * currently possible.
 *
 * WHO WRITES IT: only api/client.js, the one place every response passes
 * through. Any response carrying LLM_UNAVAILABLE (the provider circuit
 * breaker is open, FR-3.12) or SPEND_LIMIT_REACHED (the monthly ceiling,
 * or an operator's ANALYSIS_ENABLED=false, FR-5.4) marks analysis as
 * unavailable, and a successful analyze clears it. No screen has to
 * remember to report what it saw.
 *
 * HOW LONG IT LASTS: the server's Retry-After, which is the server's own
 * estimate (60 s for the breaker, an hour for the spend cutoff). Without
 * an expiry the banner would outlive the outage it describes and keep
 * the analyze button dead after the provider came back, which is the
 * mirror image of the failure this exists to prevent.
 *
 * WHY sessionStorage: a reload is the first thing a person does when a
 * button is disabled, and a reload that re-enabled it would send them
 * straight back into the failure. It is per tab and never holds anything
 * about the account (FR-7.7's "no session state in storage" is about the
 * session, which this is not). Storage can be unavailable (a private
 * window, a blocked site), so every access is guarded and the in-memory
 * copy is the one that counts.
 *
 * WHAT IT CANNOT DO, stated plainly: it learns about an outage from a
 * response. The first attempt in a tab still meets the error (it gets
 * the specific error card, not a generic one); every attempt after that,
 * until Retry-After passes, is spared it. A server-pushed status would
 * spare the first one too; there is no endpoint for that, and inventing
 * one is outside this step.
 */

/** @typedef {"LLM_UNAVAILABLE" | "SPEND_LIMIT_REACHED"} DegradedCode */
/** @typedef {{ code: DegradedCode, message: string, seconds: number, until: number }} DegradedState */

export const DEGRADED_CODES = Object.freeze(
  /** @type {ReadonlySet<string>} */ (
    new Set(["LLM_UNAVAILABLE", "SPEND_LIMIT_REACHED"])
  ),
);

/** Used when a degraded response somehow has no usable Retry-After. */
export const DEFAULT_SECONDS = Object.freeze({
  LLM_UNAVAILABLE: 60,
  SPEND_LIMIT_REACHED: 3600,
});

const STORAGE_KEY = "clausecheck:degraded";

/** @type {DegradedState | null} */
let current = readStored();
/** @type {Set<() => void>} */
const listeners = new Set();

/** @returns {DegradedState | null} */
function readStored() {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      DEGRADED_CODES.has(parsed.code) &&
      typeof parsed.message === "string" &&
      typeof parsed.seconds === "number" &&
      typeof parsed.until === "number"
    ) {
      return parsed;
    }
  } catch {
    // Unreadable or blocked storage: start from nothing.
  }
  return null;
}

/** @param {DegradedState | null} state */
function write(state) {
  current = state;
  try {
    if (state) globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
    else globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // The in-memory copy still works for this page's lifetime.
  }
  for (const listener of listeners) listener();
}

/**
 * @param {string} code
 * @param {string} message the server's own words, which differ between a
 *   spend ceiling and an operator's pause (FR-5.4), so they are kept
 * @param {number | undefined} retryAfterSeconds
 * @param {number} [now]
 */
export function markDegraded(code, message, retryAfterSeconds, now = Date.now()) {
  if (!DEGRADED_CODES.has(code)) return;
  const typed = /** @type {DegradedCode} */ (code);
  const seconds =
    retryAfterSeconds !== undefined && retryAfterSeconds > 0
      ? retryAfterSeconds
      : DEFAULT_SECONDS[typed];
  write({ code: typed, message, seconds, until: now + seconds * 1000 });
}

export function clearDegraded() {
  if (current) write(null);
}

/**
 * The current state, or null once it has expired. Expiry is decided at
 * read time, so a stale entry can never be returned.
 *
 * @param {number} [now]
 * @returns {DegradedState | null}
 */
export function getDegraded(now = Date.now()) {
  if (current && current.until <= now) {
    write(null);
    return null;
  }
  return current;
}

/** @param {() => void} listener */
export function subscribeDegraded(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget everything, including what storage held. */
export function resetDegradedForTests() {
  current = null;
  try {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // nothing to do
  }
}

/**
 * A rough, honest wait: "in about a minute", "in about 20 minutes", "in
 * about an hour". Never a clock time, which would read as a promise.
 *
 * @param {number} ms
 */
export function describeWait(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes <= 1) return "in about a minute";
  if (minutes < 55) return `in about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours <= 1 ? "in about an hour" : `in about ${hours} hours`;
}
