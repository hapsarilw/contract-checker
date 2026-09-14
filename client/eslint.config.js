import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

/**
 * FR-7.8 / SRS §10.5: `dangerouslySetInnerHTML` is banned repository-wide.
 * Restated from server/eslint.config.js rather than shared, because there
 * is no monorepo tooling here to share it through (client/ and server/ are
 * two independent npm projects) — this is the ban's other half, and the
 * one that can actually fire: server has no JSX.
 *
 * Model output is untrusted input (SRS §2.4) and is rendered as text,
 * never as markup — the excerpt verifier (server/src/services/verify.js)
 * bounds what a model can fabricate, but only if nothing downstream turns
 * a finding back into HTML.
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
    message: "FR-7.8: assign textContent, or use the framework's text rendering.",
  },
];

export default [
  {
    ignores: ["node_modules/**", "dist/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "no-restricted-syntax": ["error", ...domSafetySelectors],
    },
  },
  {
    files: ["*.config.js", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
