import { useId, useRef } from "react";
import "./Tabs.css";

/**
 * BUILD-PLAN step 30 — the "Upload a file" / "Paste the text" tab pair
 * from the prototype (docs/design/ClauseCheck.html), rebuilt as the
 * WAI-ARIA APG tabs pattern rather than the prototype's plain buttons:
 * `role="tablist"`/`"tab"`/`"tabpanel"`, a roving tabindex (only the
 * active tab is in the Tab sequence; arrow keys move both focus and
 * selection between tabs), and Home/End to jump to the first/last tab.
 *
 * Automatic activation — arrow keys select the tab immediately, not just
 * focus it — because switching panels here is instant (toggling which
 * form is visible, nothing async), matching what a click already does in
 * the prototype.
 *
 * One active panel, not one `<Tabs.Panel>` per tab: this mirrors how the
 * screens actually use it (only the file-upload form or the paste
 * textarea exists at a time, never both), and keeps this one component
 * instead of a compound-component API for a case where only one tab's
 * content is ever mounted.
 *
 * @param {{
 *   label: string,
 *   tabs: { id: string, label: string }[],
 *   activeId: string,
 *   onChange: (id: string) => void,
 *   children?: import("react").ReactNode,
 * }} props
 */
export default function Tabs({ label, tabs, activeId, onChange, children }) {
  const baseId = useId();
  const tabRefs = useRef(/** @type {Record<string, HTMLButtonElement | null>} */ ({}));

  const activeIndex = tabs.findIndex((tab) => tab.id === activeId);

  /** @param {number} index */
  function activate(index) {
    const wrapped = (index + tabs.length) % tabs.length;
    const next = tabs[wrapped];
    onChange(next.id);
    tabRefs.current[next.id]?.focus();
  }

  /** @param {import("react").KeyboardEvent<HTMLButtonElement>} event */
  function onKeyDown(event) {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        activate(activeIndex + 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        activate(activeIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        activate(0);
        break;
      case "End":
        event.preventDefault();
        activate(tabs.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div>
      <div className="cc-tablist" role="tablist" aria-label={label}>
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-${tab.id}-tab`}
              aria-selected={selected}
              aria-controls={`${baseId}-${tab.id}-panel`}
              tabIndex={selected ? 0 : -1}
              className="cc-tab"
              onClick={() => onChange(tab.id)}
              onKeyDown={onKeyDown}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        className="cc-tabpanel"
        role="tabpanel"
        id={`${baseId}-${activeId}-panel`}
        aria-labelledby={`${baseId}-${activeId}-tab`}
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  );
}
