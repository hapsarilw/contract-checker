import js from "@eslint/js";
import globals from "globals";

/**
 * FR-7.8 / SRS §10.5: `dangerouslySetInnerHTML` is banned repository-wide.
 *
 * This rule exists before the client does, deliberately. Model output is
 * untrusted input (SRS §2.4) and is rendered as text, never as markup — the
 * excerpt verifier bounds what a model can fabricate, but only if nothing
 * downstream turns a finding back into HTML. Adding the ban later means
 * adding it after the first component that would have needed it.
 */
const domSafetySelectors = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message:
      "FR-7.8: model output is untrusted and is rendered as text, never as markup.",
  },
  {
    selector: "Property[key.name='dangerouslySetInnerHTML']",
    message:
      "FR-7.8: model output is untrusted and is rendered as text, never as markup.",
  },
  {
    selector: "MemberExpression[property.name='innerHTML']",
    message:
      "FR-7.8: assign textContent, or use the framework's text rendering.",
  },
];

const noDangerousHtml = {
  "no-restricted-syntax": ["error", ...domSafetySelectors],
};

/**
 * SRS §8 / step 3: config.js is the ONLY place that reads process.env — a
 * Zod schema validates it once at boot so a missing variable fails loudly
 * there instead of surfacing as an undefined three hours later at some
 * unrelated call site. Everything else imports the resolved config object.
 */
const processEnvSelector = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message:
    "SRS §8: read configuration from src/config.js, not process.env directly.",
};

const noProcessEnv = {
  "no-restricted-syntax": ["error", ...domSafetySelectors, processEnvSelector],
};

/**
 * SRS §5.3: the excerpt verifier "shall live in its own module with no
 * dependencies". A rule rather than a comment, because an import is how the
 * safety control's behaviour could change through a file nobody reviewed as
 * part of it. These are every way an ES module — or a stray CommonJS call —
 * can pull in another module.
 */
const noDependencySelectors = [
  "ImportDeclaration",
  "ImportExpression",
  "ExportAllDeclaration",
  "ExportNamedDeclaration[source]",
  "CallExpression[callee.name='require']",
].map((selector) => ({
  selector,
  message: "SRS §5.3: verify.js is the central safety control and must import nothing.",
}));

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "dist/**", "prisma/migrations/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...noProcessEnv,
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
  {
    // The only places allowed to touch process.env: the module that
    // validates it (config.js); test helpers that spawn a child process
    // needing an env built from process.env (config.js's own tests, and
    // ops.js's version-endpoint test, which needs a GIT_SHA/BUILD_TIMESTAMP
    // config.js never had at import time); and the shared test bootstrap
    // that seeds a valid environment before config.js runs for every
    // other test.
    files: [
      "src/config.js",
      "tests/unit/config.test.js",
      "tests/integration/ops.test.js",
      // Spawns a child process whose env is built from process.env, so
      // the extraction worker inside it can be run with LOG_LEVEL=debug
      // and its own stdout captured (step 49). Same exception as
      // ops.test.js above: a child needs an env, and config.js cannot
      // hand one over.
      "tests/integration/extractionWorker.test.js",
      // Sets process.env.DATABASE_URL to the ephemeral container's
      // connection string BEFORE config.js is first imported by any
      // test — that's the whole mechanism, not a workaround for it.
      "tests/integration/globalSetup.js",
      "tests/setup.js",
      // scripts/generate-openapi.js (step 59): it builds a static
      // OpenAPI document and touches no database, Redis or LLM provider,
      // but importing server/src/openapi/build.js transitively imports
      // config.js — same shape of problem as tests/setup.js above,
      // solved the same way, for a build tool rather than a test run.
      // Unprefixed, unlike every other entry above: lint:scripts (see
      // package.json) runs eslint from the REPO ROOT (`cd .. && eslint
      // --config server/eslint.config.js scripts`), and flat config's
      // `files` patterns resolve against the CWD ESLint is invoked from,
      // not against this config file's own directory.
      "scripts/generate-openapi.js",
    ],
    rules: {
      ...noDangerousHtml,
    },
  },
  {
    // Flat config replaces a rule's options rather than merging them, so the
    // repository-wide selectors are restated alongside the new ones.
    files: ["src/services/verify.js"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...domSafetySelectors,
        processEnvSelector,
        ...noDependencySelectors,
      ],
    },
  },
];
