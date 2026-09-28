import { useEffect, useSyncExternalStore } from "react";
import { getDegraded, subscribeDegraded } from "./degraded.js";

/**
 * The current degraded-mode state (see degraded.js), re-rendering when it
 * is set or cleared, and again at the moment it expires, so a disabled
 * analyze button comes back on its own when Retry-After runs out rather
 * than waiting for the person to do something.
 *
 * @returns {import("./degraded.js").DegradedState | null}
 */
export function useDegraded() {
  // getDegraded() returns the same object until it changes, which is what
  // useSyncExternalStore needs to avoid a render loop.
  const state = useSyncExternalStore(subscribeDegraded, () => getDegraded());

  useEffect(() => {
    if (!state) return undefined;
    // getDegraded() clears an expired entry and notifies subscribers,
    // which is what re-renders this component.
    const timer = setTimeout(
      () => getDegraded(),
      Math.max(0, state.until - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [state]);

  return state;
}
