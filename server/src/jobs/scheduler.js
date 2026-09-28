import logger from "../observability/logger.js";

/**
 * The one in-process scheduler every SRS §12.3 job shares.
 *
 * Extracted at step 61, when the second job arrived, rather than copied
 * into it: step 60's reaper had its own copy of exactly this, and step 62
 * adds two more jobs. Four copies of "fire now, then on an interval,
 * swallow a failed tick, never hold the process open" is four places for
 * one of them to forget a line.
 *
 * WHAT THIS IS NOT: a guarantee that a job runs only once across the
 * fleet. Every instance runs its own timer; exclusivity comes from the
 * advisory lock each job takes inside its own tick. This only decides
 * WHEN a given instance asks.
 *
 * @param {{ job: string, tick: () => Promise<unknown>, intervalMs: number }} options
 * @returns {NodeJS.Timeout} pass to `stopRecurring` to cancel
 */
export function startRecurring({ job, tick, intervalMs }) {
  const run = () => {
    // A rejected tick is logged and dropped, never thrown into the
    // interval (an unhandled rejection) and never allowed to cancel the
    // ticks after it — one bad run must not end a job for the rest of the
    // process's life.
    tick().catch((err) => {
      logger.error({ job, err }, "scheduled job tick failed");
    });
  };

  // Once immediately, then on the interval: an instance that has just
  // booted may be the first chance in a while to do this job's work, and
  // waiting a whole interval to find out has no upside.
  run();
  const handle = setInterval(run, intervalMs);
  // Never the thing that keeps the process alive — the HTTP server does
  // that. Matches gracefulShutdown.js's own forceExit timer.
  handle.unref?.();
  return handle;
}

/** @param {NodeJS.Timeout} handle */
export function stopRecurring(handle) {
  clearInterval(handle);
}
