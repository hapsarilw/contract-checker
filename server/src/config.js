import { z } from "zod";

/**
 * SRS §5.4 — sampling parameters are model-dependent. temperature/top_p/top_k
 * are REJECTED (400) on some current models; output_config.effort is rejected
 * on others. A model with no entry here is a boot-time config error, not a
 * runtime one: better to fail on deploy than to fail every analysis on the
 * first real document (step 24 depends on this).
 */
const MODEL_PARAM_PROFILES = Object.freeze({
  "claude-opus-5": Object.freeze({ temperature: false, effort: true }),
  "claude-sonnet-5": Object.freeze({ temperature: false, effort: true }),
  "claude-opus-4-8": Object.freeze({ temperature: false, effort: true }),
  "claude-opus-4-7": Object.freeze({ temperature: false, effort: true }),
  "claude-opus-4-6": Object.freeze({ temperature: true, effort: true }),
  "claude-sonnet-4-6": Object.freeze({ temperature: true, effort: true }),
  "claude-haiku-4-5": Object.freeze({ temperature: true, effort: false }),
});

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
 * Appendix B marks REDIS_URL, LLM_PRICE_*, MONTHLY_SPEND_CEILING_USD,
 * AUDIT_SALT, EMAIL_PROVIDER_KEY, EMAIL_FROM and GIT_SHA "✓ [P1.5]" — required,
 * but only once the P1.5 features that consume them exist (Redis in step 44,
 * spend metering in step 46, email in step 51, the P1.5 gate in step 75).
 * Phase 1 (steps 1-43) has to boot without them, so they are optional here
 * and become effectively required in practice once their consuming step
 * lands and the deploy target needs them set.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: positiveInt(3000),

    DATABASE_URL: z.string().min(1, "required"),
    DATABASE_POOL_SIZE: positiveInt(10),

    REDIS_URL: z.string().min(1).optional(),

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
    LLM_TIMEOUT_MS: positiveInt(60_000),
    LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
    LLM_PRICE_INPUT_PER_MTOK: nonNegativeNumber().optional(),
    LLM_PRICE_OUTPUT_PER_MTOK: nonNegativeNumber().optional(),
    MONTHLY_SPEND_CEILING_USD: nonNegativeNumber().optional(),

    MONTHLY_ANALYSIS_QUOTA: positiveInt(50),
    HOURLY_ANALYSIS_LIMIT: positiveInt(10),
    MAX_CONCURRENT_UPLOADS: positiveInt(10),
    MAX_DOCUMENT_WORDS: positiveInt(4000),
    MIN_DOCUMENT_WORDS: positiveInt(200),
    MAX_PDF_PAGES: positiveInt(100),
    MAX_DOCS_PER_USER: positiveInt(100),
    MAX_BYTES_PER_USER: positiveInt(52_428_800),
    RETENTION_DAYS: positiveInt(90),

    JWT_SECRET: z
      .string()
      .refine((val) => Buffer.byteLength(val, "utf8") >= 32, {
        message: "must be at least 32 bytes",
      }),
    AUDIT_SALT: z
      .string()
      .refine((val) => Buffer.byteLength(val, "utf8") >= 32, {
        message: "must be at least 32 bytes",
      })
      .optional(),

    FRONTEND_ORIGIN: z
      .string()
      .regex(/^https?:\/\/[^*\s/]+(:\d+)?$/, "must be an exact origin, no wildcard, no path"),

    EMAIL_PROVIDER_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().email().optional(),

    SENTRY_DSN: z.string().min(1).optional(),
    LOG_LEVEL: z
      // "silent" is a real pino level (suppresses all output) — useful in
      // tests and CI so a deliberately-triggered error path doesn't flood
      // stdout with the log lines it's correctly producing.
      .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),
    ANALYSIS_ENABLED: booleanString().default(true),
    GIT_SHA: z.string().min(1).optional(),
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
    // Ordering constraint (SRS NFR-3.5, FR-3.6, BUILD-PLAN step 7/16):
    //   platform proxy > server request timeout > analyzeCeiling > llm
    // analyzeCeiling and shutdownDrain are fixed constants, not env-tunable —
    // moving either independently breaks the chain the comment in step 7
    // records, so they live here instead of in Appendix B.
    timeouts: Object.freeze({
      llm: parsed.LLM_TIMEOUT_MS,
      analyzeCeiling: 90_000,
      shutdownDrain: 90_000,
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
