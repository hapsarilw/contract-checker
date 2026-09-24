/**
 * BUILD-PLAN step 59 (API-4) / SRS §4's API contract.
 *
 * A thin CLI wrapper only: the actual document is built by
 * server/src/openapi/build.js, imported here by relative path rather
 * than as a package, the same way scripts/benchmark.js reaches into
 * server/src for the real analysis pipeline instead of duplicating it.
 * This file's only jobs are to render the YAML and write it to
 * docs/openapi.yaml — it does not import zod or yaml directly, since
 * neither package is resolvable from this directory (scripts/ has no
 * node_modules of its own; server/src/openapi/build.js lives inside
 * server/, where both packages are actually installed).
 *
 * Usage (from server/): npm run generate:openapi
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * server/src/openapi/build.js imports services/auth.js for
 * SESSION_COOKIE_NAME (so the security scheme's cookie name cannot drift
 * from the real one) — and services/auth.js, like almost every module
 * under server/src, transitively imports config.js, which validates
 * process.env and exits the process at import time on anything invalid.
 * This generator produces a STATIC document and touches no database, no
 * Redis and no LLM provider, so it needs none of config.js's real
 * secrets — but config.js cannot tell "a docs build" apart from "the
 * live server" at import time, and making it able to is a change to
 * security-critical validation logic this step has no business making.
 * The values below are the same harmless placeholders
 * server/tests/setup.js uses for exactly this reason, duplicated rather
 * than imported: that file is a test fixture, and coupling a build tool
 * to it would mean a test-only env change could silently break doc
 * generation, or vice versa.
 */
process.env.NODE_ENV ??= "development";
process.env.DATABASE_URL ??= "postgres://openapi-generator:unused@localhost:5432/unused";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.ANTHROPIC_API_KEY ??= "sk-ant-unused-by-this-script";
process.env.ANTHROPIC_MODEL ??= "claude-haiku-4-5";
process.env.LLM_PRICE_INPUT_PER_MTOK ??= "1";
process.env.LLM_PRICE_OUTPUT_PER_MTOK ??= "10";
process.env.MONTHLY_SPEND_CEILING_USD ??= "100";
process.env.JWT_SECRET ??= "openapi-generator-placeholder-not-a-real-secret";
process.env.AUDIT_SALT ??= "openapi-generator-placeholder-not-a-real-secret";
process.env.FRONTEND_ORIGIN ??= "http://localhost:5173";

const { buildOpenApiDocument, renderOpenApiYaml } = await import("../server/src/openapi/build.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, "..", "docs", "openapi.yaml");

const yaml = renderOpenApiYaml();
writeFileSync(outputPath, yaml, "utf8");

const doc = buildOpenApiDocument();
const pathCount = Object.keys(doc.paths).length;
const operationCount = Object.values(doc.paths).reduce((n, methods) => n + Object.keys(methods).length, 0);
const errorCodeCount = doc.components.schemas.ErrorResponse.properties.error.properties.code.enum.length;

console.log(`Wrote ${outputPath}`);
console.log(`  ${pathCount} paths, ${operationCount} operations, ${errorCodeCount} error codes documented.`);
