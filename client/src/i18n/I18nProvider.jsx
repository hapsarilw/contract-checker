import { useMemo } from "react";
import { I18nContext } from "./context.js";
import { ACTIVE_LOCALE } from "./locale.js";
import { en } from "./strings/en.js";
import { id } from "./strings/id.js";

/**
 * BUILD-PLAN step 30 / decision D-B — the provider side of "build the
 * i18n structure, ship English only, with a single config switch to
 * enable the other locale." The switch is locale.js's ACTIVE_LOCALE
 * constant, not a runtime toggle in this component: there is no
 * language-switcher UI in Phase 1 (FR-7.14, "Copy is English-only"), so
 * there is nothing for a stateful provider to switch between yet — that
 * changes when someone deliberately flips ACTIVE_LOCALE, not when a user
 * clicks something.
 *
 * FR-7.14: "strings are kept out of markup structure so that
 * localization later is a translation task, not a rewrite." This is
 * what makes that true in code — a screen reads `useI18n().t` instead of
 * writing English text inline, so flipping ACTIVE_LOCALE is the only
 * thing that has to change.
 */
const STRINGS_BY_LOCALE = { en, id };

/** @param {{ children: import("react").ReactNode }} props */
export function I18nProvider({ children }) {
  const value = useMemo(
    () => ({ locale: ACTIVE_LOCALE, t: STRINGS_BY_LOCALE[ACTIVE_LOCALE] }),
    [],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
