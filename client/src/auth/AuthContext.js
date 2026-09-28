import { createContext } from "react";

/**
 * BUILD-PLAN step 32 — split from AuthProvider.jsx for the same reason
 * i18n/context.js is split from I18nProvider.jsx: react-refresh/only-
 * export-components (client/eslint.config.js) wants one export per file,
 * component or hook, never both.
 *
 * THE SHAPE THE SERVER ACTUALLY SENDS (server/src/services/auth.js's
 * toPublicUser): `state`, not `accountState`. Until step 63 this typedef,
 * every unit-test fixture and every e2e mock said `accountState`, a field
 * the API has never returned. It never mattered because nothing read it.
 * Step 63's verification prompt is the first thing that does, and reading
 * the wrong name would have shown it to no one, ever, while every mocked
 * test passed.
 *
 * @typedef {"UNVERIFIED" | "ACTIVE" | "LOCKED" | "SUSPENDED"} AccountState
 * @typedef {{ id: string, email: string, state: AccountState, emailVerifiedAt?: string | null, createdAt?: string }} AuthUser
 * @typedef {
 *   | { status: "loading", user: null }
 *   | { status: "authenticated", user: AuthUser }
 *   | { status: "unauthenticated", user: null, endedBecause?: string }
 * } AuthState
 * @typedef {AuthState & {
 *   setUser: (user: AuthUser) => void,
 *   signOut: () => Promise<void>,
 *   clearSession: (reason?: string) => void,
 *   refreshUser: () => Promise<void>,
 * }} AuthContextValue
 */
export const AuthContext = createContext(/** @type {AuthContextValue | null} */ (null));
