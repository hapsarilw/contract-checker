import { AppError } from "../../lib/AppError.js";
import { getRedis } from "../../lib/redis.js";
import logger from "../../observability/logger.js";

/**
 * FR-3.12 — the provider circuit breaker.
 *
 * "If provider calls fail at >= 50% over a rolling window of at least 20
 * calls, the breaker opens for 60 seconds: analyze requests return 503
 * LLM_UNAVAILABLE immediately without a call. A single trial request
 * closes the breaker on success."
 *
 * WHY THE STATE IS IN REDIS, which the step calls out as mandatory. With
 * two or more stateless instances a per-process breaker sees only its own
 * share of the traffic, so it needs N times as many failures to reach the
 * same threshold and opens late — or, on a fleet large enough, never.
 * That is not a smaller version of the control; it is the control not
 * working on the day it is needed.
 *
 * AND WHY IT EXISTS AT ALL, which is the part worth keeping in mind while
 * reading the thresholds: during a provider outage every analyze request
 * queues for its full 60-second timeout. Those requests hold server
 * connections, and a partial outage becomes a total one — the API stops
 * answering the reads and logins that have nothing to do with the
 * provider. The breaker's job is to fail fast so the rest of the app
 * survives, which is the same reasoning as FR-5.6's asymmetry.
 */

const WINDOW_KEY = "llm:cb:window";
const OPEN_KEY = "llm:cb:open_until";
const TRIAL_KEY = "llm:cb:trial";

/** FR-3.12's numbers. */
export const MIN_CALLS = 20;
export const FAILURE_RATIO = 0.5;
export const OPEN_MS = 60_000;

/** How many outcomes the rolling window keeps. */
const WINDOW_SIZE = 100;

/**
 * Outcomes older than this stop counting, even if fewer than WINDOW_SIZE
 * have happened since.
 *
 * FR-3.12 specifies a window in CALLS and says nothing about time, but a
 * count-only window misbehaves on a quiet service: ten failures during
 * last night's outage would still be sitting in the window this morning,
 * and the tenth ordinary call today would trip a breaker over an incident
 * that ended hours ago. The window is therefore the last 100 outcomes
 * AND the last five minutes, whichever is smaller.
 */
const WINDOW_MS = 5 * 60_000;

/**
 * How long a tripped breaker's state outlives the moment it opened.
 *
 * It must be LONGER than OPEN_MS, and that is the whole of the half-open
 * state. The key was first written with a lifetime of exactly OPEN_MS, so
 * it vanished at the instant the open period ended: there was never a
 * moment when the key existed and the period was over, the trial branch
 * in assertCircuitClosed could not run, and every request that arrived
 * before the next failure re-opened the breaker went straight to the
 * provider, each with its full retry budget. The integration test passed
 * all along, because it moved the clock forward instead of letting the key
 * expire. Step 75's outage drill found it: four openings in five minutes,
 * no trial, two or three analyses (three calls each) through after every
 * expiry, and a gauge that read closed in each gap.
 *
 * The trial is what normally ends the tripped state: one call once the
 * open period is over, closing the breaker on success and opening it
 * again on failure. This lifetime is only the safety net for no call
 * coming at all — nobody analysing — after which there is nothing to
 * protect and the breaker closes without one.
 */
const TRIPPED_TTL_MS = OPEN_MS + WINDOW_MS;

/**
 * Records the outcome of one provider CALL — an attempt, not an analysis.
 * FR-3.12 counts calls, and a retried analysis makes up to three of them;
 * counting analyses instead would need three times the outage to trip.
 *
 * Never throws: a breaker that could fail the request it is measuring
 * would be a liability rather than a safety control.
 *
 * @param {"success" | "failure"} outcome
 * @param {Date} [now]
 */
export async function recordProviderCall(outcome, now = new Date()) {
  const ms = now.getTime();
  try {
    const redis = getRedis();
    await redis
      .multi()
      .lpush(WINDOW_KEY, `${ms}:${outcome === "success" ? "ok" : "fail"}`)
      .ltrim(WINDOW_KEY, 0, WINDOW_SIZE - 1)
      .expire(WINDOW_KEY, Math.ceil((WINDOW_MS * 2) / 1000))
      .exec();

    if (outcome === "success" && (await redis.get(OPEN_KEY))) {
      // FR-3.12: "a single trial request closes the breaker on success."
      // Clearing the window too is deliberate — leaving the failures that
      // opened it would re-open the breaker on the next single failure,
      // so one trial success would buy one call rather than a recovery.
      await redis.del(OPEN_KEY, WINDOW_KEY, TRIAL_KEY);
      logger.warn(
        { alert: "circuit_closed" },
        "FR-3.12: provider circuit closed after a successful trial",
      );
      return;
    }

    if (outcome === "failure" && (await reopenAfterFailedTrial(ms))) return;

    // Evaluated after EVERY call, not only after failures. FR-3.12's
    // condition is about the window, not about the last outcome, and a
    // success can be the call that makes the window large enough to
    // judge: 10 failures in 19 calls is below the 20-call minimum, and
    // the 20th call reaching the threshold may well be a success. Only
    // checking on failure would leave the breaker closed with its own
    // condition met, until the next failure happened to arrive.
    await maybeOpen(ms);
  } catch (err) {
    logger.warn(
      { err: { message: err instanceof Error ? err.message : String(err) } },
      "circuit breaker could not record a provider call",
    );
  }
}

/**
 * A call that fails while the breaker is HALF-OPEN (tripped, open period
 * over) is the trial failing, or a straggler from before the breaker
 * opened failing just as plainly: either way the provider is still down.
 * FR-3.12 says what a successful trial does and not what a failed one
 * does; the reading that keeps the breaker's purpose is to open again for
 * the same period, and to clear the trial slot so the next period gets
 * one trial of its own.
 *
 * @param {number} ms
 * @returns {Promise<boolean>} whether it re-opened
 */
async function reopenAfterFailedTrial(ms) {
  const redis = getRedis();
  const openUntil = await redis.get(OPEN_KEY);
  if (!openUntil || ms < Number(openUntil)) return false;
  await redis
    .multi()
    .set(OPEN_KEY, String(ms + OPEN_MS), "PX", TRIPPED_TTL_MS)
    .del(TRIAL_KEY)
    .exec();
  logger.warn(
    { alert: "circuit_reopened", openMs: OPEN_MS },
    "FR-3.12: the trial failed, so the provider circuit is open again",
  );
  return true;
}

/** @param {number} ms */
async function maybeOpen(ms) {
  const redis = getRedis();
  const entries = await redis.lrange(WINDOW_KEY, 0, WINDOW_SIZE - 1);
  const recent = entries.filter((entry) => ms - Number(entry.split(":")[0]) <= WINDOW_MS);
  if (recent.length < MIN_CALLS) return;

  const failures = recent.filter((entry) => entry.endsWith(":fail")).length;
  const ratio = failures / recent.length;
  if (ratio < FAILURE_RATIO) return;

  // SET NX: the instance that wins logs the alert, so a fleet noticing the
  // same outage raises one page rather than one per instance.
  const opened = await redis.set(
    OPEN_KEY,
    String(ms + OPEN_MS),
    "PX",
    TRIPPED_TTL_MS,
    "NX",
  );
  if (opened === "OK") {
    logger.error(
      {
        alert: "circuit_open",
        failures,
        calls: recent.length,
        ratio: Number(ratio.toFixed(2)),
        openMs: OPEN_MS,
      },
      "FR-3.12: provider circuit opened — analyses will fail fast without a provider call",
    );
  }
}

/**
 * The gate, called before a provider call is attempted.
 *
 * Throws 503 LLM_UNAVAILABLE while the breaker is open, EXCEPT for the
 * one trial request allowed once the open period has elapsed. "A single
 * trial" is enforced with SET NX rather than a local flag, so it means
 * one request across the fleet and not one per instance — otherwise a
 * recovering provider would be hit by one trial from every instance at
 * once, which is the retry storm the breaker is meant to prevent.
 *
 * Fails OPEN when Redis cannot answer, and that is the deliberate
 * direction: the breaker is an optimisation for the app's own survival,
 * so an unavailable breaker must not become a second outage on top of
 * whatever is already wrong. FR-5.6 already fails the analyze path closed
 * when Redis is down, so this cannot become an unmetered path.
 *
 * @param {Date} [now]
 */
export async function assertCircuitClosed(now = new Date()) {
  const ms = now.getTime();
  let redis;
  try {
    redis = getRedis();
    const openUntil = await redis.get(OPEN_KEY);
    if (!openUntil) return;

    if (ms < Number(openUntil)) {
      throw new AppError("LLM_UNAVAILABLE");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.warn(
      { err: { message: err instanceof Error ? err.message : String(err) } },
      "circuit breaker state unavailable — allowing the call",
    );
    return;
  }

  // The open period has elapsed. Exactly one request becomes the trial.
  const won = await redis
    .set(TRIAL_KEY, String(ms), "PX", OPEN_MS, "NX")
    .catch(() => null);
  if (won === "OK") {
    logger.warn(
      { alert: "circuit_trial" },
      "FR-3.12: circuit half-open, sending a single trial request",
    );
    return;
  }
  throw new AppError("LLM_UNAVAILABLE");
}

/**
 * Operator and test visibility: the breaker's state without a database query.
 *
 * `open` is true while the breaker is TRIPPED: open, or half-open waiting
 * for a trial to succeed. Half-open is not closed — every request but the
 * one trial is still refused — and reading it as closed made
 * llm_circuit_state drop to 0 between open periods, which reset
 * circuit_open's five minutes through any sustained outage. `halfOpen`
 * says which of the two it is.
 */
export async function getCircuitState(now = new Date()) {
  try {
    const redis = getRedis();
    const [openUntil, entries] = await Promise.all([
      redis.get(OPEN_KEY),
      redis.lrange(WINDOW_KEY, 0, WINDOW_SIZE - 1),
    ]);
    const recent = entries.filter(
      (entry) => now.getTime() - Number(entry.split(":")[0]) <= WINDOW_MS,
    );
    const failures = recent.filter((entry) => entry.endsWith(":fail")).length;
    return {
      open: Boolean(openUntil),
      halfOpen: Boolean(openUntil) && now.getTime() >= Number(openUntil),
      openUntil: openUntil ? new Date(Number(openUntil)) : null,
      calls: recent.length,
      failures,
      ratio: recent.length === 0 ? null : failures / recent.length,
    };
  } catch {
    return {
      open: false,
      halfOpen: false,
      openUntil: null,
      calls: null,
      failures: null,
      ratio: null,
    };
  }
}

/** Test-only: clears every key this module owns. */
export async function resetCircuitForTests() {
  await getRedis().del(OPEN_KEY, WINDOW_KEY, TRIAL_KEY);
}
