import { join } from "node:path";
import { Counter, register } from "prom-client";
import config from "../config.js";
import logger from "../observability/logger.js";
import { TEMPLATES } from "./email/templates.js";
import { createSinkProvider } from "./email/sinkProvider.js";

/**
 * Transactional email (BUILD-PLAN step 51; NFR-3.8, NFR-3.7, SRS §6.5).
 *
 * THE RULE THAT MATTERS: delivery failure must NEVER fail the operation
 * that triggered it. A user whose account was created successfully must not
 * see "registration failed" because a mail provider timed out. So sending
 * is ENQUEUED, not awaited: `sendEmail()` returns as soon as the message is
 * built and scheduled, and delivery, retries and failure handling all
 * happen after the caller has moved on. It also never throws — not on a
 * provider error, and not on a programming error such as an unknown
 * message type, because "this caller has a bug" is not a reason to turn a
 * successful registration into a 500.
 *
 * THE QUEUE IS IN-PROCESS, and what that costs is stated rather than left
 * to be discovered: a message still waiting to be retried is lost if the
 * process dies. For verification and reset mail that is survivable — the
 * user requests another, and FR-1.7 rate-limits resends rather than
 * forbidding them — and a durable outbox would need a job runner this
 * system does not have until Phase 2. graceful shutdown drains what is
 * pending (flushEmails), so a deploy does not drop a message that is one
 * retry from delivered.
 *
 * WHAT IS NEVER LOGGED (§6.5's never-logged list): bodies, and addresses.
 * A body is a credential here — it carries a single-use token. And a
 * provider's error MESSAGE often quotes the recipient ("mailbox
 * alice@example.com not found"), so a provider error is reduced to its
 * class name, status and code before it goes near a logger; the message
 * text is dropped on the floor deliberately. What is logged is the message
 * type, the attempt number and the outcome.
 */

/** NFR-3.7: every outbound dependency call has an explicit timeout. */
export const SEND_TIMEOUT_MS = 10_000;
export const MAX_ATTEMPTS = 3;
/** Delay before attempt 2 and attempt 3. Short: a person is waiting on this. */
const RETRY_DELAYS_MS = [1_000, 5_000];

/**
 * Sent for `sink`, which has no domain to verify. `.invalid` is reserved by
 * RFC 2606 and can never resolve, so a message that somehow escaped could
 * not be mistaken for a real sender.
 */
const SINK_FROM = "noreply@clausecheck.invalid";

/**
 * The email_send_total counter step 67 will expose. Registered on
 * prom-client's default registry, so exposing it is `register.metrics()`
 * and nothing here changes.
 *
 * Looked up before it is created: a module re-imported under
 * vi.resetModules() would otherwise try to register the same metric name
 * twice and throw.
 */
export const emailSendTotal =
  /** @type {Counter<"type" | "outcome"> | undefined} */ (register.getSingleMetric("email_send_total")) ??
  new Counter({
    name: "email_send_total",
    help: "Transactional emails by type and final outcome (sent, failed).",
    labelNames: ["type", "outcome"],
  });

/**
 * A provider error with everything that might quote an address removed.
 *
 * @param {unknown} err
 */
function describeProviderError(err) {
  const e = /** @type {{ name?: string, status?: number, statusCode?: number, code?: string }} */ (err ?? {});
  return { name: e.name ?? "Error", status: e.status ?? e.statusCode ?? null, code: e.code ?? null };
}

/**
 * A failure retrying cannot fix — a rejected address, a bad key. Providers
 * mark these with `permanent: true`; without the mark an error is assumed
 * to be transient, which errs toward one extra attempt rather than a lost
 * message.
 *
 * @param {unknown} err
 */
const isPermanent = (err) => /** @type {{ permanent?: boolean }} */ (err)?.permanent === true;

/**
 * @typedef {{
 *   name: string,
 *   send: (message: { to: string, from: string, subject: string, text: string, html: string }, options: { signal: AbortSignal }) => Promise<void>,
 * }} EmailProvider
 */

/**
 * @param {{
 *   provider: EmailProvider,
 *   from: string,
 *   frontendOrigin: string,
 *   sleep?: (ms: number) => Promise<void>,
 *   sendTimeoutMs?: number,
 * }} options
 */
export function createEmailService({
  provider,
  from,
  frontendOrigin,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sendTimeoutMs = SEND_TIMEOUT_MS,
}) {
  /** @type {Set<Promise<void>>} */
  const pending = new Set();

  /**
   * One attempt, bounded by NFR-3.7's timeout. The AbortSignal is passed
   * through so a provider that supports it can cancel the request instead
   * of leaving it running after we stopped waiting.
   *
   * @param {Parameters<EmailProvider["send"]>[0]} message
   */
  async function attempt(message) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), sendTimeoutMs);
    try {
      await Promise.race([
        provider.send(message, { signal: controller.signal }),
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("email send timed out"), { name: "TimeoutError", code: "ETIMEDOUT" })),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {string} type
   * @param {Parameters<EmailProvider["send"]>[0]} message
   */
  async function deliver(type, message) {
    for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
      try {
        await attempt(message);
        emailSendTotal.inc({ type, outcome: "sent" });
        logger.debug({ email: { type, attempt: n } }, "email sent");
        return;
      } catch (err) {
        const detail = describeProviderError(err);
        const giveUp = n === MAX_ATTEMPTS || isPermanent(err);

        if (giveUp) {
          emailSendTotal.inc({ type, outcome: "failed" });
          // `alert` gives the paging rule something stable to match. The
          // message and address are deliberately absent — see the header.
          logger.error(
            { alert: "email_send_failed", email: { type, attempt: n }, err: detail },
            "email delivery failed and will not be retried",
          );
          return;
        }

        logger.warn({ email: { type, attempt: n }, err: detail }, "email delivery failed, will retry");
        await sleep(RETRY_DELAYS_MS[n - 1] ?? RETRY_DELAYS_MS.at(-1) ?? 1_000);
      }
    }
  }

  return {
    /**
     * Builds and enqueues a message. Returns immediately and NEVER throws.
     *
     * @param {import("./email/templates.js").EmailType} type
     * @param {string} to
     * @param {Record<string, string>} [params]
     * @returns {{ queued: boolean }}
     */
    send(type, to, params = {}) {
      try {
        const template = TEMPLATES[type];
        if (!template) throw new Error(`unknown email type "${type}"`);

        const content = template(/** @type {any} */ (withLinks(type, params, frontendOrigin)));
        const message = { to, from, ...content };

        const task = deliver(type, message).finally(() => pending.delete(task));
        pending.add(task);
        return { queued: true };
      } catch (err) {
        // A programming error, not a delivery failure — but the same rule
        // applies: it must not fail the caller. Loud in the log, silent to
        // the user.
        emailSendTotal.inc({ type: String(type), outcome: "failed" });
        logger.error(
          { alert: "email_send_failed", email: { type: String(type) }, err: { message: String(/** @type {Error} */ (err)?.message ?? err) } },
          "email could not be built",
        );
        return { queued: false };
      }
    },

    /**
     * Resolves once every queued message has been delivered or given up on,
     * or when `timeoutMs` passes — whichever is first. Used by graceful
     * shutdown and by tests; a deploy should not drop a message that is one
     * retry from delivered, but should not hang on a dead provider either.
     *
     * @param {number} [timeoutMs]
     */
    async flush(timeoutMs = 5_000) {
      if (pending.size === 0) return;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
      ]);
    },

    pendingCount: () => pending.size,
    provider,
  };
}

/**
 * Turns the tokens the callers hold into the links the templates want.
 * Kept here, not in the templates, so a template stays a pure function of
 * its inputs and cannot reach for config.
 *
 * The paths are provisional until step 63 builds the screens they point at.
 *
 * @param {string} type
 * @param {Record<string, string>} params
 * @param {string} origin
 */
function withLinks(type, params, origin) {
  if (type === "verification") {
    return { verifyUrl: `${origin}/verify-email?token=${encodeURIComponent(params.token ?? "")}` };
  }
  if (type === "password_reset") {
    return { resetUrl: `${origin}/reset-password?token=${encodeURIComponent(params.token ?? "")}` };
  }
  return params;
}

/** @type {ReturnType<typeof createEmailService> | undefined} */
let service;

/**
 * The process-wide service, built on first use rather than at import — the
 * same pattern as getLlmProvider() and getRedis(), for the same reason:
 * importing this module must not touch the filesystem or the network.
 */
export function getEmailService() {
  if (service) return service;

  // NODE_ENV=test keeps the sink in memory only, so the test run does not
  // litter the working tree. Anywhere else the directory is what a
  // separate E2E process reads (see sinkProvider.js).
  const dir = config.EMAIL_SINK_DIR ?? (config.NODE_ENV === "test" ? undefined : join(process.cwd(), ".mail-sink"));

  service = createEmailService({
    provider: createSinkProvider({ dir }),
    from: config.EMAIL_FROM ?? SINK_FROM,
    frontendOrigin: config.FRONTEND_ORIGIN,
  });
  return service;
}

/**
 * The call site every feature uses:
 *   sendEmail("verification", user.email, { token })
 *
 * @param {import("./email/templates.js").EmailType} type
 * @param {string} to
 * @param {Record<string, string>} [params]
 */
export function sendEmail(type, to, params) {
  return getEmailService().send(type, to, params);
}

/** Graceful shutdown hook. */
export async function flushEmails(timeoutMs) {
  await service?.flush(timeoutMs);
}

/** Test-only: forgets the memoised service so the next call rebuilds it. */
export function resetEmailForTests() {
  service = undefined;
}
