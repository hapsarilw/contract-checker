import { createContext } from "react";

/**
 * BUILD-PLAN step 32 — split from AuthProvider.jsx for the same reason
 * i18n/context.js is split from I18nProvider.jsx: react-refresh/only-
 * export-components (client/eslint.config.js) wants one export per file,
 * component or hook, never both.
 *
 * @typedef {{ id: string, email: string, accountState: string }} AuthUser
 * @typedef {
 *   | { status: "loading", user: null }
 *   | { status: "authenticated", user: AuthUser }
 *   | { status: "unauthenticated", user: null }
 * } AuthState
 * @typedef {AuthState & { setUser: (user: AuthUser) => void, signOut: () => Promise<void> }} AuthContextValue
 */
export const AuthContext = createContext(/** @type {AuthContextValue | null} */ (null));
