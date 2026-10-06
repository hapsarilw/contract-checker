import { randomUUID } from "node:crypto";

/**
 * The "resend" email provider (BUILD-PLAN step 75): Resend's HTTP API,
 * https://resend.com/docs/api-reference/emails/send-email. The first real
 * transport. Until it existed no production-mode process could boot at all,
 * staging included, because config.js refuses the sink there.
 *
 * Plain fetch, no SDK: one POST is the whole integration, and every
 * dependency on the request path is something to keep patched.
 *
 * What lib/email.js expects of a provider, and how this meets it:
 *
 *   resolve on delivery     a 2xx from Resend means accepted for delivery.
 *   reject, never hang      the AbortSignal from email.js's NFR-3.7 timeout
 *                           is passed to fetch, so a stalled request is
 *                           cancelled rather than abandoned.
 *   `permanent: true`       on a 4xx Resend will answer the same way every
 *                           time (a bad key, an unverified domain, an
 *                           invalid address), so email.js stops retrying.
 *                           429 and 5xx are left transient.
 *   no address in errors    the response body is never read into the
 *                           error: a provider's message can quote the
 *                           recipient, and errors are logged.
 *
 * ONE MESSAGE, ONE IDEMPOTENCY KEY, ACROSS RETRIES. email.js retries an
 * attempt that timed out, and a timeout does not mean Resend did not
 * accept it. Sending the same Idempotency-Key with every attempt of one
 * message lets Resend drop the duplicate, rather than mailing a user two
 * password-reset links of which only the second works.
 *
 * @param {{ apiKey: string, fetchImpl?: typeof fetch, endpoint?: string }} options
 */
export function createResendProvider({
  apiKey,
  fetchImpl = fetch,
  endpoint = "https://api.resend.com/emails",
}) {
  /** @type {WeakMap<object, string>} */
  const keys = new WeakMap();

  return {
    name: "resend",

    /**
     * @param {{ to: string, from: string, subject: string, text: string, html: string }} message
     * @param {{ signal: AbortSignal }} options
     */
    async send(message, { signal }) {
      let key = keys.get(message);
      if (!key) {
        key = randomUUID();
        keys.set(message, key);
      }
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal,
      });
      if (res.ok) return;
      // The body is drained, never read into the error (see above).
      await res.arrayBuffer().catch(() => undefined);
      const permanent =
        res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      throw Object.assign(new Error(`email provider answered ${res.status}`), {
        name: "EmailProviderError",
        status: res.status,
        permanent,
      });
    },
  };
}
