import { describe, expect, it } from "vitest";
import { createResendProvider } from "../../src/lib/email/resendProvider.js";
import { createEmailService } from "../../src/lib/email.js";
import { parseConfig } from "../../src/config.js";

/**
 * Step 75: the first real email transport. Resend's API is faked at the
 * fetch boundary, so what is checked is exactly what would go over the
 * wire, and what each kind of answer does.
 */

const MESSAGE = {
  to: "ann@example.test",
  from: "ClauseCheck <noreply@mail.example.test>",
  subject: "Confirm your email",
  text: "Open https://app.example.test/verify-email?token=abc",
  html: "<p>Open the link</p>",
};

/** @param {number[]} statuses one per call; the last one repeats */
function fakeFetch(statuses) {
  /** @type {{ url: string, init: RequestInit }[]} */
  const calls = [];
  const impl = /** @type {typeof fetch} */ (
    async (url, init) => {
      calls.push({ url: String(url), init: /** @type {RequestInit} */ (init) });
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
      return new Response(JSON.stringify({ message: `mailbox ${MESSAGE.to} rejected` }), {
        status,
      });
    }
  );
  return { impl, calls };
}

const signal = () => new AbortController().signal;

describe("createResendProvider", () => {
  it("POSTs the message to Resend with the key, as JSON, the recipient in a list", async () => {
    const { impl, calls } = fakeFetch([200]);
    await createResendProvider({ apiKey: "re_test_key", fetchImpl: impl }).send(MESSAGE, {
      signal: signal(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.method).toBe("POST");
    const headers = /** @type {Record<string, string>} */ (calls[0].init.headers);
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      from: MESSAGE.from,
      to: [MESSAGE.to],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
    });
  });

  it("passes the abort signal through, so a timeout cancels the request", async () => {
    const { impl, calls } = fakeFetch([200]);
    const controller = new AbortController();
    await createResendProvider({ apiKey: "k", fetchImpl: impl }).send(MESSAGE, {
      signal: controller.signal,
    });
    expect(calls[0].init.signal).toBe(controller.signal);
  });

  it.each([400, 401, 403, 422])(
    "a %i is permanent: retrying cannot help",
    async (status) => {
      const { impl } = fakeFetch([status]);
      await expect(
        createResendProvider({ apiKey: "k", fetchImpl: impl }).send(MESSAGE, {
          signal: signal(),
        }),
      ).rejects.toMatchObject({ status, permanent: true });
    },
  );

  it.each([408, 429, 500, 503])(
    "a %i is transient: worth another attempt",
    async (status) => {
      const { impl } = fakeFetch([status]);
      await expect(
        createResendProvider({ apiKey: "k", fetchImpl: impl }).send(MESSAGE, {
          signal: signal(),
        }),
      ).rejects.toMatchObject({ status, permanent: false });
    },
  );

  it("never puts the provider's answer, which can quote the address, into the error", async () => {
    const { impl } = fakeFetch([422]);
    const err = await createResendProvider({ apiKey: "k", fetchImpl: impl })
      .send(MESSAGE, { signal: signal() })
      .catch((e) => e);
    expect(JSON.stringify({ message: err.message, ...err })).not.toContain(MESSAGE.to);
  });

  it("sends every attempt of one message with ONE idempotency key, and a new message with a new one", async () => {
    // email.js retries a timed-out attempt, which Resend may already have
    // accepted; the shared key is what lets Resend drop the duplicate.
    const { impl, calls } = fakeFetch([500, 500, 200]);
    const service = createEmailService({
      provider: createResendProvider({ apiKey: "k", fetchImpl: impl }),
      from: MESSAGE.from,
      frontendOrigin: "https://app.example.test",
      sleep: async () => {},
    });
    service.send("verification", "ann@example.test", { token: "abc" });
    await service.flush();
    service.send("verification", "bob@example.test", { token: "def" });
    await service.flush();

    const keys = calls.map(
      (c) => /** @type {Record<string, string>} */ (c.init.headers)["Idempotency-Key"],
    );
    expect(keys).toHaveLength(4);
    expect(new Set(keys.slice(0, 3)).size).toBe(1);
    expect(keys[3]).not.toBe(keys[0]);
  });
});

describe("EMAIL_PROVIDER=resend in config (step 75)", () => {
  /** @param {Record<string, string>} overrides */
  const env = (overrides) => ({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://test:test@localhost:5432/clausecheck_test",
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_MODEL: "claude-haiku-4-5",
    JWT_SECRET: "test-jwt-secret-at-least-32-bytes-long-ok",
    FRONTEND_ORIGIN: "http://localhost:5173",
    REDIS_URL: "redis://localhost:6379",
    AUDIT_SALT: "test-audit-salt-at-least-32-bytes-long-ok",
    LLM_PRICE_INPUT_PER_MTOK: "2",
    LLM_PRICE_OUTPUT_PER_MTOK: "10",
    MONTHLY_SPEND_CEILING_USD: "10",
    ...overrides,
  });

  it("needs its key and a sender", () => {
    expect(() => parseConfig(env({ EMAIL_PROVIDER: "resend" }))).toThrow(
      /EMAIL_PROVIDER_KEY/,
    );
    expect(() =>
      parseConfig(env({ EMAIL_PROVIDER: "resend", EMAIL_PROVIDER_KEY: "re_x" })),
    ).toThrow(/EMAIL_FROM/);
    expect(
      parseConfig(
        env({
          EMAIL_PROVIDER: "resend",
          EMAIL_PROVIDER_KEY: "re_x",
          EMAIL_FROM: "noreply@mail.example.test",
        }),
      ).EMAIL_PROVIDER,
    ).toBe("resend");
  });
});
