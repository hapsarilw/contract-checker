import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import app from "../../src/app.js";
import config from "../../src/config.js";
import { ERROR_CODES } from "../../src/lib/errorCodes.js";
import {
  buildOpenApiDocument,
  expressPathToOpenApiPath,
  ROUTES,
} from "../../src/openapi/build.js";
import { registeredRoutes } from "../helpers/registeredRoutes.js";

/**
 * BUILD-PLAN step 59 (API-4) / SRS §4's API contract:
 *
 *   "the surface is described by a committed OpenAPI 3.1 document
 *    generated from the Zod schemas, so the specification cannot drift
 *    from the implementation. A contract test asserts every documented
 *    endpoint exists and every documented error code is reachable."
 *
 * No live server, no database — this is a UNIT test. Everything it
 * checks is static: the real app's registered routes (importing
 * src/app.js never opens a connection — see lib/prisma.js and
 * lib/redis.js's own comments on lazy construction), the generated
 * document, and the committed file on disk.
 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const OPENAPI_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "openapi.yaml",
);

const HTTP_METHODS_WITH_A_ROUTE_TABLE_ENTRY = new Set([
  "get",
  "post",
  "delete",
  "put",
  "patch",
]);

/**
 * registeredRoutes() reports a sub-router's OWN root route
 * (`router.get("/", ...)`) as the mount prefix plus a literal trailing
 * "/" — e.g. POST /api/v1/documents is recorded as
 * "/api/v1/documents/", because that is what Express's own path
 * concatenation produces internally (csrf.test.js's own comment on
 * registeredRoutes notes the same thing). Express's ROUTER still
 * matches a real request to the clean, no-slash path at request time —
 * this is an artifact of how the introspection walk concatenates
 * strings, not a second, different route a client could hit. The
 * OpenAPI doc uses the clean path (what §4's table shows, and what a
 * client actually requests), so this is where the two get reconciled.
 */
function normalizeTrailingSlash(path) {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * The one set of live routes the contract deliberately does not describe:
 * step 68's staging-only alert drills. They are mounted only when
 * ALERT_DRILL_TOKEN is set, which config.js refuses to allow in production at
 * all, so they are not API surface — documenting them in a contract clients
 * read would advertise endpoints that must never answer in production.
 *
 * Narrow on purpose, and guarded: the test below asserts that this exclusion
 * removes EXACTLY the drill routes and nothing else, so it cannot become a
 * place to hide an undocumented endpoint.
 */
const STAGING_ONLY_PREFIX = "/api/v1/drills/";

/** @param {string} entry "METHOD /path" */
const isStagingOnly = (entry) => entry.split(" ")[1].startsWith(STAGING_ONLY_PREFIX);

describe("OpenAPI contract (SRS §4, step 59)", () => {
  it("documents every method+path the live Express app actually registers", () => {
    const live = registeredRoutes(app)
      .map((entry) => {
        const [method, expressPath] = entry.split(" ");
        return `${method} ${normalizeTrailingSlash(expressPathToOpenApiPath(expressPath))}`;
      })
      // Express's catch-all 404 handler (app.js) is `app.use(...)` with no
      // `.route`, so registeredRoutes() never sees it — nothing to filter
      // out here. Every entry that DOES appear is a real, routed endpoint.
      .filter((entry) => !isStagingOnly(entry))
      .sort();

    const doc = buildOpenApiDocument();
    const documented = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const method of Object.keys(methods)) {
        if (HTTP_METHODS_WITH_A_ROUTE_TABLE_ENTRY.has(method))
          documented.push(`${method.toUpperCase()} ${path}`);
      }
    }
    documented.sort();

    // The direction the step's own DoD names explicitly: "adding an
    // undocumented route fails the contract test." A route the live app
    // serves but this file's ROUTES table never mentions shows up here.
    const undocumented = live.filter((route) => !documented.includes(route));
    expect(
      undocumented,
      "a route exists on the live app with no OpenAPI entry — add it to ROUTES in src/openapi/build.js",
    ).toEqual([]);
  });

  it("does not document a path+method the live app no longer serves", () => {
    // The other direction: a route removed from the app but left behind
    // in ROUTES would describe an endpoint that 404s. Symmetric with
    // csrf.test.js's own "does not list routes that no longer exist".
    const live = new Set(
      registeredRoutes(app).map((entry) => {
        const [method, expressPath] = entry.split(" ");
        return `${method} ${normalizeTrailingSlash(expressPathToOpenApiPath(expressPath))}`;
      }),
    );

    const doc = buildOpenApiDocument();
    const stale = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const method of Object.keys(methods)) {
        if (!HTTP_METHODS_WITH_A_ROUTE_TABLE_ENTRY.has(method)) continue;
        const key = `${method.toUpperCase()} ${path}`;
        if (!live.has(key)) stale.push(key);
      }
    }
    expect(
      stale,
      "an OpenAPI path describes a route the live app no longer registers",
    ).toEqual([]);
  });

  it("ROUTES has exactly one entry per live route — no duplicates, nothing missing", () => {
    // The two tests above catch set-difference in either direction; this
    // one catches the count drifting even when both sets happen to
    // match (e.g. a duplicate ROUTES entry masking a genuinely missing
    // one, or the reverse).
    const live = registeredRoutes(app).filter(
      (entry) =>
        HTTP_METHODS_WITH_A_ROUTE_TABLE_ENTRY.has(entry.split(" ")[0].toLowerCase()) &&
        !isStagingOnly(entry),
    );
    expect(ROUTES.length).toBe(live.length);
  });

  it("excludes exactly the staging-only drill routes, and nothing else, from the contract", () => {
    // The exclusion above is the only hole in "every live route is
    // documented", so this pins its size and shape. If a drill route is
    // added, it must appear here; if anything else ever matches the prefix,
    // this fails.
    const excluded = registeredRoutes(app).filter(isStagingOnly).sort();
    expect(excluded).toEqual([
      "POST /api/v1/drills/cross-user-access",
      "POST /api/v1/drills/unverified-excerpt",
    ]);
    // And they exist here only because the token is set, which is the same
    // switch production is forbidden to turn on (see tests/unit/config.test.js).
    expect(config.ALERT_DRILL_TOKEN).toBeTruthy();
    expect(config.isProduction).toBe(false);
  });

  it("the committed docs/openapi.yaml is exactly what the generator produces right now — not hand-edited, not stale", () => {
    // This is the test that makes "generated, not hand-written" real
    // rather than aspirational: it proves the FILE ON DISK matches a
    // fresh build, so a schema change without re-running
    // `npm run generate:openapi` (server/src/openapi/build.js's own
    // header explains why) fails CI instead of shipping a spec that
    // quietly describes yesterday's contract.
    const onDisk = parseYaml(readFileSync(OPENAPI_PATH, "utf8"));
    const fresh = buildOpenApiDocument();
    expect(onDisk).toEqual(fresh);
  });

  it("the error schema's code enum is exactly ERROR_CODES — nothing added, nothing missing", () => {
    const doc = buildOpenApiDocument();
    const documentedCodes =
      doc.components.schemas.ErrorResponse.properties.error.properties.code.enum;
    expect(new Set(documentedCodes)).toEqual(new Set(Object.keys(ERROR_CODES)));
  });

  it("states the versioning policy from SRS §4", () => {
    const doc = buildOpenApiDocument();
    expect(doc.info.description).toContain("/api/v2");
    expect(doc.info.description).toContain("90 days");
    expect(doc.info.description).toContain("Additive fields are not breaking");
  });
});

/**
 * "if a code is defined but no route can produce it, that is a finding
 * worth surfacing rather than hiding" — the step's own instruction.
 *
 * PROVEN STATICALLY, in two layers, rather than by triggering all 27
 * codes over real HTTP: several (SPEND_LIMIT_REACHED, LLM_TIMEOUT,
 * ACCOUNT_LOCKED's 10-failed-logins precondition, SERVER_BUSY's forced
 * Redis outage...) need heavy scenario setup that the rest of this suite
 * already builds and asserts on behaviourally (rateLimits.test.js,
 * spend.test.js, lockout.test.js, providerResilience.test.js). A second
 * copy of that setup here would test the setup, not the contract.
 *
 *   1. the code appears in a REAL `new AppError("CODE", ...)` call site
 *      somewhere under server/src (not a test file, not a comment).
 *   2. the file that call site lives in is reachable from src/app.js by
 *      a static import walk — so a call site in a file nothing imports
 *      does not count as "reachable" just because the string exists.
 */
describe("every ERROR_CODES entry is reachable from the live app (step 59's own instruction)", () => {
  const IMPORT_SPECIFIER_RE = /\bimport\s+(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/g;

  /**
   * `new URL("../workers/extract.worker.js", import.meta.url)` — how
   * extractionWorker.js locates its worker THREAD's entry point
   * (services/extractionWorker.js's own header explains why: a static
   * `import` would pull worker code into the main thread instead of
   * handing the Worker constructor a file to load separately). It is a
   * second, real edge in the reachability graph — pdf.js and docx.js are
   * only reachable THROUGH it — even though it is not an `import`
   * statement at all. Missing this specific pattern is exactly the kind
   * of false negative this whole check exists to avoid: ENCRYPTED_DOCUMENT
   * failed here first, wrongly, before this line existed.
   */
  const WORKER_URL_RE = /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;

  /** Every .js file under `dir`, recursively — src/ has no test files, but excluded defensively anyway. */
  function listSourceFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listSourceFiles(full));
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".js") &&
        !entry.name.endsWith(".test.js")
      ) {
        out.push(full);
      }
    }
    return out;
  }

  /** This codebase has no dynamic `import()` anywhere under src/ (verified while writing this test) — a static regex over the source text, PLUS the worker-URL pattern above, is a complete, not approximate, view of the graph. */
  function localImportsOf(file) {
    const text = readFileSync(file, "utf8");
    const specifiers = [];
    let match;
    while ((match = IMPORT_SPECIFIER_RE.exec(text))) specifiers.push(match[1]);
    while ((match = WORKER_URL_RE.exec(text))) specifiers.push(match[1]);
    return specifiers
      .filter((s) => s.startsWith("."))
      .map((s) => resolve(dirname(file), s));
  }

  function filesReachableFrom(entryFile) {
    const seen = new Set();
    const stack = [resolve(entryFile)];
    while (stack.length > 0) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const imported of localImportsOf(file)) {
        if (!seen.has(imported)) stack.push(imported);
      }
    }
    return seen;
  }

  const sourceFiles = listSourceFiles(SRC_DIR);
  const reachableFromApp = filesReachableFrom(join(SRC_DIR, "app.js"));

  // Anti-vacuity: the reachability set itself has to be non-trivial, or
  // every test below would pass for the wrong reason (an empty set that
  // "contains" nothing meaningful, or a walk that silently found
  // nothing because the entry point path was wrong).
  it("the import walk actually found more than just app.js", () => {
    expect(reachableFromApp.size).toBeGreaterThan(20);
    expect(sourceFiles.length).toBeGreaterThan(reachableFromApp.size * 0.5);
  });

  for (const code of Object.keys(ERROR_CODES)) {
    it(`${code}`, () => {
      const pattern = new RegExp(`new AppError\\(\\s*["']${code}["']`);
      const callSites = sourceFiles.filter((file) =>
        pattern.test(readFileSync(file, "utf8")),
      );

      expect(
        callSites.length,
        `${code} is defined in errorCodes.js but no new AppError('${code}'...) call exists anywhere under server/src`,
      ).toBeGreaterThan(0);

      const reachableCallSites = callSites.filter((file) => reachableFromApp.has(file));
      expect(
        reachableCallSites.length,
        `${code} is thrown only from file(s) src/app.js never imports, so no live route can produce it: ${callSites.join(", ")}`,
      ).toBeGreaterThan(0);
    });
  }
});
