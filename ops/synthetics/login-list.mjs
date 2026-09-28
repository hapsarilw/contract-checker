// SRS §6.6's external synthetic check: /api/health, then a full login ->
// list round trip. Dependency-free (Node 18+ fetch), so any runner can
// execute it: a monitoring provider's scripted check, or `node` on a
// schedule. ops/README.md says how it must be scheduled (two regions, one
// minute) and why the auth limiter lets it through.
//
//   SYNTHETIC_BASE_URL=https://api.example.com \
//   SYNTHETIC_ACCOUNT_EMAIL=... SYNTHETIC_ACCOUNT_PASSWORD=... \
//   SYNTHETIC_CHECK_TOKEN=... node ops/synthetics/login-list.mjs
//
// Exits 0 when all three steps pass, 1 otherwise. Prints timings and
// statuses only: never the password, the token or the session cookie.

const STEP_TIMEOUT_MS = 10_000;

/**
 * @param {{
 *   baseUrl: string,
 *   email: string,
 *   password: string,
 *   checkToken: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ ok: boolean, steps: { step: string, ok: boolean, status: number | null, ms: number, reason?: string }[] }>}
 */
export async function runCheck({ baseUrl, email, password, checkToken, fetchImpl = fetch }) {
  /** @type {{ step: string, ok: boolean, status: number | null, ms: number, reason?: string }[]} */
  const steps = [];

  /**
   * @param {string} step
   * @param {() => Promise<Response>} call
   * @param {(res: Response) => Promise<string | null>} judge null when it passed, else why not
   */
  async function run(step, call, judge) {
    const started = Date.now();
    try {
      const res = await call();
      const reason = await judge(res);
      steps.push({ step, ok: reason === null, status: res.status, ms: Date.now() - started, ...(reason ? { reason } : {}) });
      return reason === null ? res : null;
    } catch (err) {
      steps.push({ step, ok: false, status: null, ms: Date.now() - started, reason: err instanceof Error ? err.name : "error" });
      return null;
    }
  }

  const signal = () => AbortSignal.timeout(STEP_TIMEOUT_MS);

  const health = await run(
    "health",
    () => fetchImpl(`${baseUrl}/api/health`, { signal: signal() }),
    async (res) => (res.status === 200 ? null : "not 200"),
  );
  if (!health) return { ok: false, steps };

  const login = await run(
    "login",
    () =>
      fetchImpl(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Synthetic-Check": checkToken },
        body: JSON.stringify({ email, password }),
        signal: signal(),
      }),
    async (res) => (res.status === 200 ? null : res.status === 429 ? "rate limited: is this runner's address on SYNTHETIC_CHECK_IPS?" : "not 200"),
  );
  if (!login) return { ok: false, steps };

  // The session is the cookie's name=value; its attributes are the browser's business.
  const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""])
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");

  const list = await run(
    "list",
    () => fetchImpl(`${baseUrl}/api/v1/documents`, { headers: { Cookie: cookie }, signal: signal() }),
    async (res) => {
      if (res.status !== 200) return "not 200";
      const body = /** @type {{ documents?: unknown } | null} */ (await res.json().catch(() => null));
      return Array.isArray(body?.documents) ? null : "no documents array";
    },
  );
  return { ok: Boolean(list), steps };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const env = process.env;
  const missing = ["SYNTHETIC_BASE_URL", "SYNTHETIC_ACCOUNT_EMAIL", "SYNTHETIC_ACCOUNT_PASSWORD", "SYNTHETIC_CHECK_TOKEN"].filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    console.error(`missing: ${missing.join(", ")}`);
    process.exit(1);
  }
  const result = await runCheck({
    baseUrl: /** @type {string} */ (env.SYNTHETIC_BASE_URL).replace(/\/$/, ""),
    email: /** @type {string} */ (env.SYNTHETIC_ACCOUNT_EMAIL),
    password: /** @type {string} */ (env.SYNTHETIC_ACCOUNT_PASSWORD),
    checkToken: /** @type {string} */ (env.SYNTHETIC_CHECK_TOKEN),
  });
  for (const s of result.steps) {
    console.log(`${s.ok ? "ok  " : "FAIL"} ${s.step.padEnd(6)} ${String(s.status ?? "-").padStart(3)} ${s.ms} ms${s.reason ? `  (${s.reason})` : ""}`);
  }
  process.exit(result.ok ? 0 : 1);
}
