/**
 * BUILD-PLAN decision D-B, option B1 — "Build the i18n structure, ship
 * English only... makes turning Indonesian on a config change."
 *
 * This constant is that config change. Both string sets exist and are
 * fully translated (strings/en.js, strings/id.js); nothing about turning
 * Indonesian on requires touching a screen, because FR-7.14 already
 * requires every screen to read copy through the i18n system rather than
 * hardcoding English text.
 *
 * SRS FR-7.14 is still in force ("Copy is English-only in Phase 1") —
 * this is not that decision being made unilaterally by editing a
 * constant. Changing ACTIVE_LOCALE ships a second, unreviewed copy
 * surface into every screen a user sees, which is exactly what BUILD-PLAN
 * decision D-B's rejected option B2 warned against ("Adds a second copy
 * surface to every legal review under §12.2, including the disclaimer").
 * Treat flipping this the same way: a product/legal decision, not a
 * one-line PR.
 */
export const ACTIVE_LOCALE = "en";

export const SUPPORTED_LOCALES = ["en", "id"];
