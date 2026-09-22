import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "prom-client";
import logger from "../../src/observability/logger.js";
import { createEmailService, emailSendTotal, MAX_ATTEMPTS } from "../../src/lib/email.js";
import { TEMPLATES, escapeHtml, maskEmail } from "../../src/lib/email/templates.js";
import { createSinkProvider, extractFirstLink } from "../../src/lib/email/sinkProvider.js";

/**
 * BUILD-PLAN step 51 — transactional email, NFR-3.8.
 *
 * No network and no real provider: the service takes its provider as an
 * argument, so every failure mode is produced by handing it one that
 * misbehaves. `sleep` is injected so retries cost no wall-clock time.
 */

const FROM = "noreply@clausecheck.invalid";
const ORIGIN = "https://app.example.test";
const SECRET_TOKEN = "TOKEN-abc123-single-use";
const ADDRESS = "alice.sensitive@example.com";

const noSleep = async () => {};

/** @param {Partial<Parameters<typeof createEmailService>[0]>} [overrides] */
function service(overrides = {}) {
  const sink = createSinkProvider();
  const svc = createEmailService({
    provider: sink,
    from: FROM,
    frontendOrigin: ORIGIN,
    sleep: noSleep,
    ...overrides,
  });
  return { svc, sink };
}

/** Everything the logger was asked to write, at every level, as one string. */
function captureLogs() {
  const calls = [];
  for (const level of /** @type {const} */ (["trace", "debug", "info", "warn", "error", "fatal"])) {
    vi.spyOn(logger, level).mockImplementation((...args) => {
      calls.push(args);
    });
  }
  return { text: () => JSON.stringify(calls), calls };
}

async function counts() {
  const { values } = await emailSendTotal.get();
  return Object.fromEntries(values.map((v) => [`${v.labels.type}/${v.labels.outcome}`, v.value]));
}

beforeEach(() => {
  emailSendTotal.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NFR-3.8 — a delivery failure never reaches the caller", () => {
  it("returns without throwing when the provider always fails", async () => {
    const { svc } = service({
      provider: { name: "broken", send: async () => { throw new Error("provider down"); } },
    });

    // The whole requirement: registration calls this and carries on.
    expect(() => svc.send("verification", ADDRESS, { token: SECRET_TOKEN })).not.toThrow();
    expect(svc.send("verification", ADDRESS, { token: SECRET_TOKEN })).toEqual({ queued: true });
    await svc.flush();
  });

  it("does not make the caller wait for delivery", async () => {
    // Enqueued, not awaited: a slow provider must not slow registration.
    /** @type {() => void} */
    let finish = () => {};
    const { svc } = service({
      provider: { name: "slow", send: () => new Promise((resolve) => (finish = () => resolve(undefined))) },
    });

    const startedAt = Date.now();
    svc.send("verification", ADDRESS, { token: SECRET_TOKEN });

    expect(Date.now() - startedAt).toBeLessThan(50);
    expect(svc.pendingCount()).toBe(1);
    finish();
    await svc.flush();
    expect(svc.pendingCount()).toBe(0);
  });

  it("does not throw for a programming error either — an unknown type", async () => {
    const { svc } = service();
    // @ts-expect-error deliberately not a real type
    expect(svc.send("no_such_template", ADDRESS)).toEqual({ queued: false });
    // Loud in the metrics even though silent to the user.
    expect(await counts()).toEqual({ "no_such_template/failed": 1 });
  });

  it("does not throw when a template cannot be built from its params", async () => {
    const { svc } = service();
    // A caller that passes nothing for a template that needs a link.
    expect(() => svc.send("verification", ADDRESS)).not.toThrow();
    await svc.flush();
  });

  it("times out a provider that never answers, instead of hanging (NFR-3.7)", async () => {
    const { svc } = service({
      provider: { name: "hung", send: () => new Promise(() => {}) },
      sendTimeoutMs: 15,
    });

    svc.send("verification", ADDRESS, { token: SECRET_TOKEN });
    await svc.flush(2_000);

    expect(await counts()).toEqual({ "verification/failed": 1 });
  });
});

describe("retry", () => {
  it("retries a transient failure and reports the eventual success", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValue(undefined);
    const { svc } = service({ provider: { name: "flaky", send } });

    svc.send("password_reset", ADDRESS, { token: SECRET_TOKEN });
    await svc.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(await counts()).toEqual({ "password_reset/sent": 1 });
  });

  it("gives up after the attempt budget and reports failure once", async () => {
    const send = vi.fn().mockRejectedValue(new Error("down"));
    const { svc } = service({ provider: { name: "down", send } });

    svc.send("verification", ADDRESS, { token: SECRET_TOKEN });
    await svc.flush();

    expect(send).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(await counts()).toEqual({ "verification/failed": 1 });
  });

  it("does not retry a permanent failure such as a rejected address", async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("rejected"), { permanent: true }));
    const { svc } = service({ provider: { name: "strict", send } });

    svc.send("verification", ADDRESS, { token: SECRET_TOKEN });
    await svc.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual({ "verification/failed": 1 });
  });

  it("waits between attempts, backing off", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockRejectedValue(new Error("down"));
    const { svc } = service({ provider: { name: "down", send }, sleep });

    svc.send("verification", ADDRESS, { token: SECRET_TOKEN });
    await svc.flush();

    expect(sleep).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1);
    expect(sleep.mock.calls[1][0]).toBeGreaterThan(sleep.mock.calls[0][0]);
  });
});

describe("email_send_total — counted on BOTH outcomes, labelled by type", () => {
  it("increments sent on success and failed on failure, per type", async () => {
    const ok = service();
    ok.svc.send("verification", ADDRESS, { token: SECRET_TOKEN });
    ok.svc.send("password_changed", ADDRESS);
    await ok.svc.flush();

    const bad = service({ provider: { name: "down", send: async () => { throw new Error("x"); } } });
    bad.svc.send("password_reset", ADDRESS, { token: SECRET_TOKEN });
    await bad.svc.flush();

    expect(await counts()).toEqual({
      "verification/sent": 1,
      "password_changed/sent": 1,
      "password_reset/failed": 1,
    });
  });

  it("is registered on prom-client's default registry, ready for step 67 to expose", async () => {
    expect(register.getSingleMetric("email_send_total")).toBe(emailSendTotal);
    expect(await register.metrics()).toContain("email_send_total");
  });
});

describe("what is NEVER logged (SRS §6.5)", () => {
  it("does not log the body, the token, or the address on success", async () => {
    const logs = captureLogs();
    const { svc } = service();

    svc.send("verification", ADDRESS, { token: SECRET_TOKEN });
    await svc.flush();

    expect(logs.calls.length).toBeGreaterThan(0); // it did log something
    for (const forbidden of [SECRET_TOKEN, ADDRESS, "Confirm your email", "works once"]) {
      expect(logs.text()).not.toContain(forbidden);
    }
  });

  it("does not log a provider error MESSAGE, which often quotes the recipient", async () => {
    // "mailbox alice@... not found" is exactly what real providers return.
    // The error is reduced to its class, status and code; the message is
    // dropped, so the address inside it cannot reach a log.
    const logs = captureLogs();
    const err = Object.assign(new Error(`550 mailbox ${ADDRESS} does not exist`), {
      name: "SmtpError",
      status: 550,
      code: "EENVELOPE",
      permanent: true,
    });
    const { svc } = service({ provider: { name: "strict", send: async () => { throw err; } } });

    svc.send("verification", ADDRESS, { token: SECRET_TOKEN });
    await svc.flush();

    expect(logs.text()).not.toContain(ADDRESS);
    expect(logs.text()).not.toContain("does not exist");
    // But it still says something useful.
    expect(logs.text()).toContain("SmtpError");
    expect(logs.text()).toContain("550");
    expect(logs.text()).toContain("email_send_failed");
  });

  it("logs the message TYPE and the attempt, which is what an operator needs", async () => {
    const logs = captureLogs();
    const { svc } = service({ provider: { name: "down", send: async () => { throw new Error("x"); } } });

    svc.send("password_reset", ADDRESS, { token: SECRET_TOKEN });
    await svc.flush();

    expect(logs.text()).toContain("password_reset");
    expect(logs.text()).toContain('"attempt"');
  });

  it.each(Object.keys(TEMPLATES))("the %s template has no logger to log itself with", (type) => {
    // Templates are pure functions of their inputs. Calling one must not
    // write a single log line, whatever it is given.
    const logs = captureLogs();
    TEMPLATES[/** @type {keyof typeof TEMPLATES} */ (type)]({
      verifyUrl: `${ORIGIN}/x?token=${SECRET_TOKEN}`,
      resetUrl: `${ORIGIN}/y?token=${SECRET_TOKEN}`,
      confirmUrl: `${ORIGIN}/z?token=${SECRET_TOKEN}`,
      newEmail: ADDRESS,
    });
    expect(logs.calls).toHaveLength(0);
  });
});

describe("shutdown", () => {
  it("flush waits for a message that is still being delivered", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValue(undefined);
    const { svc } = service({ provider: { name: "flaky", send } });

    svc.send("verification", ADDRESS, { token: SECRET_TOKEN });
    await svc.flush();

    expect(await counts()).toEqual({ "verification/sent": 1 });
  });

  it("flush gives up on a dead provider rather than hanging the deploy", async () => {
    const { svc } = service({ provider: { name: "hung", send: () => new Promise(() => {}) }, sendTimeoutMs: 60_000 });
    svc.send("verification", ADDRESS, { token: SECRET_TOKEN });

    const startedAt = Date.now();
    await svc.flush(60);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("templates", () => {
  it("the verification link carries the token and points at the frontend", async () => {
    const { svc, sink } = service();
    svc.send("verification", ADDRESS, { token: SECRET_TOKEN });
    await svc.flush();

    const message = sink.latestTo(ADDRESS);
    expect(message?.subject).toMatch(/confirm/i);
    expect(extractFirstLink(message?.text ?? "")).toBe(`${ORIGIN}/verify-email?token=${SECRET_TOKEN}`);
    expect(message?.from).toBe(FROM);
  });

  it("encodes a token that is not URL-safe rather than breaking the link", async () => {
    const { svc, sink } = service();
    svc.send("verification", ADDRESS, { token: "a b&c=d" });
    await svc.flush();
    expect(extractFirstLink(sink.latestTo(ADDRESS)?.text ?? "")).toBe(`${ORIGIN}/verify-email?token=a%20b%26c%3Dd`);
  });

  it("the reset email states the 30-minute expiry FR-1.8 sets", async () => {
    const { svc, sink } = service();
    svc.send("password_reset", ADDRESS, { token: SECRET_TOKEN });
    await svc.flush();
    expect(sink.latestTo(ADDRESS)?.text).toContain("30 minutes");
  });

  it.each(["password_changed", "email_changed", "account_deleted"])(
    "the %s notice contains NO link — a notice that could be acted on is a phishing template",
    async (type) => {
      const { svc, sink } = service();
      svc.send(/** @type {any} */ (type), ADDRESS, { newEmail: "someone.else@example.net" });
      await svc.flush();
      const message = sink.latestTo(ADDRESS);
      expect(extractFirstLink(message?.text ?? "")).toBeUndefined();
      expect(message?.html).not.toContain("href");
    },
  );

  it("the email-change notice masks the new address instead of printing it", async () => {
    const { svc, sink } = service();
    svc.send("email_changed", ADDRESS, { newEmail: "attacker@evil.example" });
    await svc.flush();
    const message = sink.latestTo(ADDRESS);
    expect(message?.text).toContain("a****@evil.example");
    expect(message?.text).not.toContain("attacker@evil.example");
  });

  it("the deletion notice states that backups age out, not instant erasure (PRD §12.4)", async () => {
    const { svc, sink } = service();
    svc.send("account_deleted", ADDRESS);
    await svc.flush();
    expect(sink.latestTo(ADDRESS)?.text).toMatch(/30 days/);
  });

  it("escapes HTML in the html part", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
    const { html } = TEMPLATES.verification({ verifyUrl: `${ORIGIN}/v?a=1&b="><script>` });
    expect(html).not.toContain("<script>");
  });

  it("masks an address, and copes with one that is malformed", () => {
    expect(maskEmail("alice@example.com")).toBe("a****@example.com");
    expect(maskEmail("not-an-address")).toBe("****");
    expect(maskEmail("@nolocal.com")).toBe("****");
  });
});

describe("the sink provider", () => {
  it("keeps messages in memory, oldest first", async () => {
    const sink = createSinkProvider();
    await sink.send({ to: "a@x.test", from: FROM, subject: "one", text: "1", html: "1" });
    await sink.send({ to: "b@x.test", from: FROM, subject: "two", text: "2", html: "2" });
    expect(sink.messages().map((m) => m.subject)).toEqual(["one", "two"]);
    expect(sink.latestTo("b@x.test")?.subject).toBe("two");
    sink.clear();
    expect(sink.messages()).toEqual([]);
  });

  it("writes one JSON file per message when given a directory — what a separate E2E process reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clausecheck-sink-"));
    try {
      const sink = createSinkProvider({ dir: join(dir, "nested") });
      await sink.send({ to: "a@x.test", from: FROM, subject: "hello", text: `${ORIGIN}/v?token=t`, html: "" });

      const files = await readdir(join(dir, "nested"));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.json$/);
      const stored = JSON.parse(await readFile(join(dir, "nested", files[0]), "utf8"));
      expect(stored).toMatchObject({ to: "a@x.test", subject: "hello" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds the first link in a body, and none where there is none", () => {
    expect(extractFirstLink("Confirm:\nhttps://app.example.test/verify-email?token=abc\n— x")).toBe(
      "https://app.example.test/verify-email?token=abc",
    );
    expect(extractFirstLink("no link here")).toBeUndefined();
  });
});
