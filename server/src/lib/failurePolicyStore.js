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
 *
 * INIT [step 75]: a Redis that is unreachable when the process starts
 * (Render's Key Value restarting during a deploy) is an outage like any
 * other, not a reason to crash. rate-limit-redis's init loads its two Lua
 * scripts and rejects when it cannot; express-rate-limit calls init and
 * discards what this decorator returns, so before this step that rejection
 * was unhandled and the process exited at boot. Worse, the store keeps the
 * rejected script promises and awaits them on every increment, and only a
 * NOSCRIPT reply makes it load them again: had the process survived, every
 * limiter would have stayed failed after Redis came back, the analyze path
 * refusing every request until a restart. So a failed init is recorded,
 * not thrown, and the next increment initialises the store again before
 * using it; one retry is shared by the requests that arrive while it runs.
 * A retry that fails is a store failure like any other, and the policy
 * applies.
 */

/**
 * @typedef {"open" | "closed"} FailurePolicy
 * @typedef {import("express-rate-limit").Store} Store
 * @typedef {import("express-rate-limit").ClientRateLimitInfo} ClientRateLimitInfo
 */

/**
 * What a fail-CLOSED refusal says (step 75; the owner's decision of
 * 2026-10-12). Until then it said SERVER_BUSY's own text, "The server is at
 * capacity right now... try again in a few seconds", with Retry-After 5:
 * untrue on both counts. The server was idle and Redis was down, and the
 * Redis outage drill showed it repeated every five seconds for five
 * minutes. The code stays SERVER_BUSY (FR-5.6 names it); the message says
 * what is actually true, and the wait is long enough for Redis to come back.
 *
 * Here rather than in rateLimits.js so the outage drill can state the
 * expected answer without importing a module that connects to Redis.
 */
export const STORE_UNAVAILABLE_RETRY_AFTER_SECONDS = 60;
export const STORE_UNAVAILABLE_MESSAGE =
  "This is unavailable for a moment, because a service it depends on isn't answering. Nothing has been lost. Try again in about a minute.";
/** The analyze limiter's: checking is what stops, and saved work is what still works. */
export const ANALYZE_UNAVAILABLE_MESSAGE =
  "Checking a contract is unavailable for a moment, because a service it depends on isn't answering. Your contract is saved and your saved reports still open. Try again in about a minute.";

export class FailurePolicyStore {
  /** @type {Store} */
  #inner;
  /** @type {FailurePolicy} */
  #policy;
  /** @type {(err: unknown, policy: FailurePolicy) => void} */
  #onFailure;
  /** @type {number} */
  #windowMs = 60_000;
  /** @type {string} */
  #unavailableMessage;
  /** @type {Record<string, unknown> | undefined} */
  #options;
  /**
   * The inner store's last init: settles to null once it is ready, or to the
   * reason it is not. It never rejects. A store never initialised counts as
   * ready, as express-rate-limit treats a store without init.
   *
   * @type {Promise<unknown>}
   */
  #ready = Promise.resolve(null);

  /**
   * @param {{
   *   store: Store,
   *   policy: FailurePolicy,
   *   onFailure?: (err: unknown, policy: FailurePolicy) => void,
   *   unavailableMessage?: string,
   * }} options
   */
  constructor({
    store,
    policy,
    onFailure,
    unavailableMessage = STORE_UNAVAILABLE_MESSAGE,
  }) {
    this.#inner = store;
    this.#unavailableMessage = unavailableMessage;
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
    this.#options = options;
    this.#ready = this.#initInner();
  }

  /** @returns {Promise<unknown>} see #ready */
  #initInner() {
    try {
      return Promise.resolve(this.#inner.init?.(/** @type {any} */ (this.#options))).then(
        () => null,
        (err) => err ?? new Error("rate-limit store failed to initialise"),
      );
    } catch (err) {
      return Promise.resolve(err ?? new Error("rate-limit store failed to initialise"));
    }
  }

  /** Throws the reason the inner store cannot be used yet, if it cannot. */
  async #whenReady() {
    const ready = this.#ready;
    if ((await ready) === null) return;
    // Every request that saw the same failed init shares one retry.
    if (this.#ready === ready) this.#ready = this.#initInner();
    const reason = await this.#ready;
    if (reason !== null) throw reason;
  }

  /**
   * @param {string} key
   * @returns {Promise<ClientRateLimitInfo>}
   */
  async increment(key) {
    try {
      await this.#whenReady();
      return await this.#inner.increment(key);
    } catch (err) {
      this.#onFailure(err, this.#policy);
      if (this.#policy === "closed") {
        throw new AppError("SERVER_BUSY", {
          message: this.#unavailableMessage,
          retryAfter: STORE_UNAVAILABLE_RETRY_AFTER_SECONDS,
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
