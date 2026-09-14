import { createContext } from "react";

/**
 * Split into its own module so I18nProvider.jsx (a component) and
 * useI18n.js (a hook) can each export exactly one thing —
 * react-refresh/only-export-components (client/eslint.config.js) warns
 * when a file mixes component and non-component exports, since Fast
 * Refresh can't reliably hot-reload that file either way.
 *
 * `import("./strings/en.js").en` in the type annotation, not a value
 * import of `en` — this file needs the SHAPE of the English string map
 * for the type, never the map itself at runtime, and a value import used
 * only inside a JSDoc comment reads as unused to eslint's no-unused-vars.
 */
export const I18nContext = createContext(
  /** @type {{ locale: string, t: import("./strings/en.js").en } | null} */ (null),
);
