import { useContext } from "react";
import { I18nContext } from "./context.js";

/**
 * `t` (matching the prototype's own `t.overallRisk`-style access) is the
 * active locale's full string map — there's no interpolation or plural
 * logic to route through a `t(key)` function yet, since every string in
 * the L map is static text, so a direct property lookup is what "kept
 * out of markup structure" means here: `t.copyLabel`, not `"Copy this
 * ask"` typed into a screen.
 */
export function useI18n() {
  const context = useContext(I18nContext);
  if (context === null) {
    throw new Error("useI18n() must be called inside an <I18nProvider>");
  }
  return context;
}
