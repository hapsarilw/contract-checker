import { z } from "zod";
import { parseIpAllowlist } from "./lib/ipAllowlist.js";

/**
 * SRS §5.4 — sampling parameters are model-dependent. temperature/top_p/top_k
 * are REJECTED (400) on some current models; output_config.effort is rejected
 * on others. A model with no entry here is a boot-time config error, not a
 * runtime one: better to fail on deploy than to fail every analysis on the
 * first real document (step 24 depends on this).
 */
export const MODEL_PARAM_PROFILES = Object.freeze({
  "claude-opus-5": Object.freeze({ temperature: false, effort: true }),
  "claude-sonnet-5": Object.freeze({ temperature: false, effort: true }),
  "claude-opus-4-8": Object.freeze({ temperature: false, effort: true }),
  "claude-opus-4-7": Object.freeze({ temperature: false, effort: true }),
  "claude-opus-4-6": Object.freeze({ temperature: true, effort: true }),
  "claude-sonnet-4-6": Object.freeze({ temperature: true, effort: true }),
  "claude-haiku-4-5": Object.freeze({ temperature: true, effort: false }),
});

/**
 * The timeout chain that must hold end to end (FR-3.6, FR-3.7, NFR-3.5):
 *
 *   platform proxy > server request timeout > analyze ceiling > LLM timeout
 *
 * Only the LLM timeout is env-tunable (Appendix B's LLM_TIMEOUT_MS). The
 * rest are fixed here because moving one independently silently breaks the
 * chain: raise the LLM timeout past the analyze ceiling and every long
 * analysis is cut off by the layer above it instead of completing. The
 * `superRefine` on the schema below enforces that ordering at boot rather
 * than leaving it to a comment nobody reads.
 *
 * The platform proxy is the one link this process cannot verify — FR-3.7
 * requires checking it in staging, which is why index.js logs these values
 * at boot instead of assuming them.
 */
const ANALYZE_CEILING_MS = 90_000;
const SHUTDOWN_DRAIN_MS = 90_000;
const SERVER_REQUEST_TIMEOUT_MS = 120_000;
// Node closes idle keep-alive sockets at keepAliveTimeout; headersTimeout
// must exceed it, or a request arriving just as the socket is being closed
// is dropped as a 502 by the proxy in front of it. Both sit above the
// server request timeout so neither cuts a slow analysis short.
const KEEP_ALIVE_TIMEOUT_MS = 121_000;
const HEADERS_TIMEOUT_MS = 125_000;

/**
 * z.coerce.boolean() treats any non-empty string as true — "false" would be
 * truthy. This accepts only the literal strings "true" / "false"
 * (case-insensitive) and rejects everything else.
 */
function booleanString(message) {
  return z.string().transform((val, ctx) => {
    const normalized = val.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    ctx.addIssue({ code: "custom", message: message ?? 'expected "true" or "false"' });
    return z.NEVER;
  });
}

const positiveInt = (fallback) =>
  fallback === undefined
    ? z.coerce.number().int().positive()
    : z.coerce.number().int().positive().default(fallback);

const nonNegativeNumber = () => z.coerce.number().nonnegative();

/**
 * Appendix B marks EMAIL_PROVIDER_KEY, EMAIL_FROM, GIT_SHA
 * and BUILD_TIMESTAMP "✓ [P1.5]" — required,
 * but only once the P1.5 features that consume them exist (email in step
 * 51, the P1.5 gate in step 75). Phase 1 (steps 1-43) had to boot without
 * them, so they are optional here and become required once their
 * consuming step lands — which is what happened to REDIS_URL at step 44,
 * the three spend variables at step 46, and AUDIT_SALT at step 56, and
 * why none of them are in this list any more.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: positiveInt(3000),

    DATABASE_URL: z.string().min(1, "required"),
    DATABASE_POOL_SIZE: positiveInt(10),

    // Required since step 44: rate limits are counted here, so an
    // instance without it cannot enforce a fleet-wide limit at all.
    REDIS_URL: z.string().min(1, "required"),

    ANTHROPIC_API_KEY: z.string().min(1, "required"),
    ANTHROPIC_MODEL: z.string().min(1, "required").superRefine((val, ctx) => {
      if (!(val in MODEL_PARAM_PROFILES)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown model "${val}" — no §5.4 parameter profile. Known models: ${Object.keys(
            MODEL_PARAM_PROFILES,
          ).join(", ")}`,
        });
      }
    }),
    // §2.3: ci uses the mock provider only — no network calls to the
    // real provider from CI. `anthropic` calls the real API; `mock`
    // selects server/src/services/llm/mockProvider.js.
    LLM_PROVIDER: z.enum(["anthropic", "mock"]).default("anthropic"),
    LLM_TIMEOUT_MS: positiveInt(60_000),
    LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
    // Required since step 46. FR-5.3's estimate is computed from these, so
    // an unset price does not mean "free" — it means the ceiling cannot be
    // enforced at all. BUILD-PLAN D-F: re-set both whenever
    // ANTHROPIC_MODEL changes, or the estimate silently meters the new
    // model at the old price. scripts/benchmark.js, which already gates
    // every model change, checks that for you.
    LLM_PRICE_INPUT_PER_MTOK: nonNegativeNumber(),
    LLM_PRICE_OUTPUT_PER_MTOK: nonNegativeNumber(),
    MONTHLY_SPEND_CEILING_USD: nonNegativeNumber(),

    MONTHLY_ANALYSIS_QUOTA: positiveInt(50),
    HOURLY_ANALYSIS_LIMIT: positiveInt(10),
    MAX_CONCURRENT_UPLOADS: positiveInt(10),
    MAX_DOCUMENT_WORDS: positiveInt(4000),
    MIN_DOCUMENT_WORDS: positiveInt(200),
    MAX_PDF_PAGES: positiveInt(100),
    MAX_DOCS_PER_USER: positiveInt(100),
    MAX_BYTES_PER_USER: positiveInt(52_428_800),
    RETENTION_DAYS: positiveInt(90),

    // Step 62 / SRS §12.3's backup-verify job. Backups themselves are made
    // by the managed database provider (§5.6: "verified, not assumed"), so
    // this is only WHERE the job looks for evidence of them: a directory
    // of backup files. Unset in production is not "skip the check" — the
    // job runs anyway and FAILS, loudly, because a backup nobody can find
    // is exactly what it exists to catch. See jobs/backupVerify.js.
    BACKUP_DIR: z.string().min(1).optional(),
    // The floor below which a backup is implausible. Deliberately a floor
    // and not a target: the real guard against a truncated dump is the
    // comparison with the previous backup, which needs no tuning.
    BACKUP_MIN_BYTES: positiveInt(1_048_576),
    // Backups run at least daily on every candidate provider; a newest
    // backup older than this means they have stopped.
    BACKUP_MAX_AGE_HOURS: positiveInt(36),

    JWT_SECRET: z
      .string()
      .refine((val) => Buffer.byteLength(val, "utf8") >= 32, {
        message: "must be at least 32 bytes",
      }),
    // Required since step 56: audit rows are hmac'd with this, and rotating
    // it silently breaks correlation across every historical row — see
    // lib/audit.js.
    AUDIT_SALT: z
      .string()
      .refine((val) => Buffer.byteLength(val, "utf8") >= 32, {
        message: "must be at least 32 bytes",
      }),

    FRONTEND_ORIGIN: z
      .string()
      .regex(/^https?:\/\/[^*\s/]+(:\d+)?$/, "must be an exact origin, no wildcard, no path"),

    // Which transport sends transactional email (step 51). Only "sink" exists
    // today: it writes each message to a local directory instead of sending
    // it, which is what development and the step-73 E2E tests need. A real
    // provider is added by extending this enum and adding one file under
    // src/lib/email/ — the rest of the system never learns which
    // one is in use. EMAIL_PROVIDER_KEY becomes required for any provider
    // other than "sink" at that point.
    EMAIL_PROVIDER: z.enum(["sink"]).default("sink"),
    EMAIL_PROVIDER_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().email().optional(),
    EMAIL_SINK_DIR: z.string().min(1).optional(),

    SENTRY_DSN: z.string().min(1).optional(),

    // Step 67 / §6.6. The bearer token a scraper presents to GET /metrics
    // (observability/metrics.js explains why metrics are a token-protected
    // route rather than a second port). Required in production, below:
    // unset, there would be no metrics, and so no alert could ever fire.
    METRICS_TOKEN: z
      .string()
      .refine((val) => Buffer.byteLength(val, "utf8") >= 32, {
        message: "must be at least 32 bytes",
      })
      .optional(),
    // The OTLP/HTTP collector traces go to. Unset, tracing is off and
    // costs nothing. The exporter reads this and the other standard
    // OTEL_EXPORTER_OTLP_* variables (e.g. _HEADERS for an authenticated
    // collector) itself; it is declared here so a malformed URL fails boot.
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

    // Step 67 / §6.6's synthetic login round trip. A checker signing in
    // every minute from two regions would trip NFR-2.6's 5-per-15-minutes
    // auth limiter within five minutes. These three together let exactly
    // that checker through the limiter and nothing else: the request must
    // come from an allowlisted address, carry the token, AND sign in as the
    // synthetic account (middleware/rateLimits.js). All three or none.
    SYNTHETIC_CHECK_TOKEN: z
      .string()
      .refine((val) => Buffer.byteLength(val, "utf8") >= 32, {
        message: "must be at least 32 bytes",
      })
      .optional(),
    // Comma-separated IPs or CIDR ranges: the monitoring provider's
    // published checker addresses.
    SYNTHETIC_CHECK_IPS: z
      .string()
      .min(1)
      .superRefine((val, ctx) => {
        try {
          parseIpAllowlist(val);
        } catch (err) {
          ctx.addIssue({ code: "custom", message: /** @type {Error} */ (err).message });
        }
      })
      .optional(),
    SYNTHETIC_ACCOUNT_EMAIL: z.string().email().optional(),
    LOG_LEVEL: z
      // "silent" is a real pino level (suppresses all output) — useful in
      // tests and CI so a deliberately-triggered error path doesn't flood
      // stdout with the log lines it's correctly producing.
      .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),
    ANALYSIS_ENABLED: booleanString().default(true),
    GIT_SHA: z.string().min(1).optional(),
    BUILD_TIMESTAMP: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    // The sink provider writes messages to disk instead of sending them. In
    // production that would silently swallow every verification and
    // password-reset email — accounts created, nobody able to verify —
    // with no error anywhere, because "written to a file" is a success.
    // Refusing to boot is the only place that failure is loud.
    if (env.NODE_ENV === "production" && env.EMAIL_PROVIDER === "sink") {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_PROVIDER"],
        message:
          'the "sink" provider only writes messages to disk and must not run in production; ' +
          "configure a real transactional email provider",
      });
    }

    // §6.6: in production, metrics exist and are private, or boot stops.
    if (env.NODE_ENV === "production" && !env.METRICS_TOKEN) {
      ctx.addIssue({
        code: "custom",
        path: ["METRICS_TOKEN"],
        message:
          "required in production: without it GET /metrics is disabled, nothing can be " +
          "scraped, and no alert in Appendix C can fire",
      });
    }

    // The synthetic-check bypass is all-or-nothing: a token with no address
    // allowlist, or an allowlist with no account, would be a looser bypass
    // than anyone intended.
    const synthetic = [
      env.SYNTHETIC_CHECK_TOKEN,
      env.SYNTHETIC_CHECK_IPS,
      env.SYNTHETIC_ACCOUNT_EMAIL,
    ].filter(Boolean).length;
    if (synthetic !== 0 && synthetic !== 3) {
      ctx.addIssue({
        code: "custom",
        path: ["SYNTHETIC_CHECK_TOKEN"],
        message:
          "SYNTHETIC_CHECK_TOKEN, SYNTHETIC_CHECK_IPS and SYNTHETIC_ACCOUNT_EMAIL must be set together or not at all",
      });
    }

    // FR-3.7 / NFR-3.5: LLM_TIMEOUT_MS is the one env-tunable link in the
    // timeout chain, so it is the one that can break it. A value at or
    // above the analyze ceiling means the ceiling cuts off an analysis the
    // provider was still answering — a silent, intermittent failure that
    // looks like a provider problem. Fail at boot instead.
    if (env.LLM_TIMEOUT_MS >= ANALYZE_CEILING_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["LLM_TIMEOUT_MS"],
        message: `must be below the ${ANALYZE_CEILING_MS} ms analyze ceiling (got ${env.LLM_TIMEOUT_MS}) — see the timeout chain in config.js`,
      });
    }
  });
/**
 * Deliberately NOT .strict(): process.env always carries dozens of
 * variables this schema has no opinion on — PATH, HOME, SHELL, npm_*,
 * editor and CI-injected vars. Rejecting boot over an unrelated shell
 * variable would make the app unbootable on every real machine.
 * z.object's default "strip" mode is what we want here: validate the
 * variables we declared, silently drop everything else from the parsed
 * output so the frozen config object carries only our own fields.
 * (Request bodies and LLM output elsewhere DO use .strict() — rejecting
 * an unexpected key there is exactly the point; that distinction is
 * deliberate, not an inconsistency.)
 */

/**
 * Pure function: env in, resolved config out or throws ZodError. Kept
 * separate from the process.exit side effect below so tests can assert on
 * validation behavior directly via a child process (see
 * tests/unit/config.test.js) without needing to fork for every case, and so
 * nothing here is untestable-by-construction.
 */
export function parseConfig(rawEnv) {
  const parsed = envSchema.parse(rawEnv);
  const llmParamProfile = MODEL_PARAM_PROFILES[parsed.ANTHROPIC_MODEL];

  return Object.freeze({
    ...parsed,
    isProduction: parsed.NODE_ENV === "production",
    llmParamProfile: Object.freeze({ ...llmParamProfile, model: parsed.ANTHROPIC_MODEL }),
    // The timeout chain, resolved. See the constants above for why only
    // `llm` is env-tunable and why the ordering is enforced at boot.
    timeouts: Object.freeze({
      llm: parsed.LLM_TIMEOUT_MS,
      analyzeCeiling: ANALYZE_CEILING_MS,
      shutdownDrain: SHUTDOWN_DRAIN_MS,
      serverRequest: SERVER_REQUEST_TIMEOUT_MS,
      keepAlive: KEEP_ALIVE_TIMEOUT_MS,
      headers: HEADERS_TIMEOUT_MS,
    }),
  });
}

function formatIssue(issue) {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `  ${path}: ${issue.message}`;
}

let config;
try {
  config = parseConfig(process.env);
} catch (err) {
  if (err instanceof z.ZodError) {
    console.error("Invalid configuration — refusing to boot:");
    for (const issue of err.issues) {
      console.error(formatIssue(issue));
    }
  } else {
    console.error("Invalid configuration — refusing to boot:", err);
  }
  process.exit(1);
}

export default config;
