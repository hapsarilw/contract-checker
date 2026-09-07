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
    // validates it (config.js); the test helper that spawns config.js in a
    // child process with a controlled env, which needs process.env.PATH to
    // build a working child environment; and the shared test bootstrap that
    // seeds a valid environment before config.js runs for every other test.
    files: ["src/config.js", "tests/unit/config.test.js", "tests/setup.js"],
    rules: {
      ...noDangerousHtml,
    },
  },
];
