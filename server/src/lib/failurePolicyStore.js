import { AppError } from "./AppError.js";

/**
 * FR-5.6 — what a limiter does when Redis is unavailable.
 *
 *   "Where Redis is unavailable, limiters shall fail CLOSED for analysis
 *    (returning 503 SERVER_BUSY) and fail OPEN for read paths. An unmetered
 *    analyze path is a financial risk; an unmetered history page is not."
 *
 * The asymmetry is the whole requirement, and it is why this is a STORE
 * decorator rather than one try/catch around the limiter or one branch in
 * the global error handler. By the time an error reaches errorHandler.js,
 * every limiter's failure looks identical — same error, same shape, no
 * record of which bucket produced it. The decision has to be made where the
 * policy is known, which is where the limiter is built.
 *
 * Both policies depend on the failure arriving quickly — see lib/redis.js
 * for the measured client settings that guarantee it.
 *
 * FAIL OPEN means the request proceeds unmetered: a synthetic "first hit in
 * the window" is returned, so express-rate-limit sees a count below the
 * limit and calls next(). Nothing is persisted, so the window never
 * advances while Redis is down — which is the honest behaviour, not a bug:
 * an unmetered path is exactly what FR-5.6 chose for the read paths.
 *
 * FAIL CLOSED means the request is refused with 503 SERVER_BUSY, thrown as
 * an AppError so it travels the one error path SRS §4 requires, arriving
 * with the standard body and the Retry-After header errorHandler.js already
 * produces. It is NOT a 429: the client did nothing wrong and has no limit
 * to back off from — the server cannot currently tell whether it should be
 * allowed, and says so.
 *
 * Only `increment` applies the policy. The other store methods are
 * bookkeeping that no request outcome depends on: a failed `decrement` or
 * `resetKey` during an outage must not turn a request that already
 * succeeded into an error, so they are swallowed. `resetAll` is the
 * exception — it is test-only, and a test that silently fails to reset
 * state is worse than one that fails loudly.
 */

/**
 * @typedef {"open" | "closed"} FailurePolicy
 * @typedef {import("express-rate-limit").Store} Store
 * @typedef {import("express-rate-limit").ClientRateLimitInfo} ClientRateLimitInfo
 */

export class FailurePolicyStore {
  /** @type {Store} */
  #inner;
  /** @type {FailurePolicy} */
  #policy;
  /** @type {(err: unknown, policy: FailurePolicy) => void} */
  #onFailure;
  /** @type {number} */
  #windowMs = 60_000;

  /**
   * @param {{
   *   store: Store,
   *   policy: FailurePolicy,
   *   onFailure?: (err: unknown, policy: FailurePolicy) => void,
   * }} options
   */
  constructor({ store, policy, onFailure }) {
    this.#inner = store;
    this.#policy = policy;
    this.#onFailure = onFailure ?? (() => {});
  }

  /**
   * express-rate-limit hands every store the resolved options. The window
   * is kept so a fail-open response can carry a truthful resetTime rather
   * than a guess.
   *
   * @param {{ windowMs: number } & Record<string, unknown>} options
   */
  init(options) {
    this.#windowMs = options.windowMs;
    this.#inner.init?.(/** @type {any} */ (options));
  }

  /**
   * @param {string} key
   * @returns {Promise<ClientRateLimitInfo>}
   */
  async increment(key) {
    try {
      return await this.#inner.increment(key);
    } catch (err) {
      this.#onFailure(err, this.#policy);
      if (this.#policy === "closed") {
        throw new AppError("SERVER_BUSY", {
          details: { reason: "rate-limit store unavailable" },
        });
      }
      // totalHits is 1, not 0: express-rate-limit validates that a store
      // reports a positive hit count, and 1 is also the honest number —
      // this request happened, it just could not be recorded.
      return { totalHits: 1, resetTime: new Date(Date.now() + this.#windowMs) };
    }
  }

  /** @param {string} key */
  async decrement(key) {
    try {
      await this.#inner.decrement(key);
    } catch (err) {
      this.#onFailure(err, this.#policy);
    }
  }

  /** @param {string} key */
  async resetKey(key) {
    try {
      await this.#inner.resetKey(key);
    } catch (err) {
      this.#onFailure(err, this.#policy);
    }
  }

  /** Test-only, and deliberately not swallowed — see the header comment. */
  async resetAll() {
    await this.#inner.resetAll?.();
  }

  async shutdown() {
    await this.#inner.shutdown?.();
  }
}
