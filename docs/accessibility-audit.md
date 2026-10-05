# Accessibility audit: WCAG 2.2 Level AA

The record PRD §9's Phase 1.5 definition of done asks for (BUILD-PLAN step 65, SRS §7.15, NFR-4.4, PRD §13). Audited 2026-09-28 against the repository as of this file's commit.

**Verdict: NOT COMPLETE.** The automated audit and the keyboard-only pass are done. Every defect they found is fixed and guarded by a test that fails if it comes back. **The screen-reader pass has not been done.** §7.15 makes that pass mandatory, and nothing in this document stands in for it. Until a person has done it (§5 is the script), this audit cannot close, and PRD §13's "blocking defects fixed before launch" can't be claimed, because nobody has looked for the defects that only a screen reader shows.

| Part | Status |
|---|---|
| Automated checks on all seven screens (§2) | **Done**: zero violations |
| Keyboard-only pass of the whole journey (§3) | **Done**: scripted real key presses, with the limits stated in §3 |
| Screen-reader pass (§5) | **Not done**: needs a person, and the script is in §5 |
| Defects found (§4) | 3 found, **3 fixed**, each with a regression test |

---

## 1. Scope and tools

**Screens (§7.15's list):** `/login`, `/register`, `/` (upload), the analyzing screen, `/documents` (history), `/documents/:id` (report) and `/settings`. The three account-flow screens built in step 63 (`/verify-email`, `/forgot-password`, `/reset-password`) are not on §7.15's list. They still get axe assertions in `client/e2e/account.spec.js`.

**Content:** realistic content throughout (`client/e2e/support/mockApi.js`). The report has four real-length findings, glossary terms, and a missing-protections section, not one-letter placeholders. A layout that holds for "a" can still break on a 40-word clause.

**Tools:**

| Tool | Version | Used for |
|---|---|---|
| Playwright | 1.63.0 | Driving the browser, key presses, viewport, `prefers-reduced-motion` emulation |
| Chromium (Playwright build) | 153.0.8010.12 | The only engine audited (see §6) |
| axe-core via `@axe-core/playwright` | 4.12.1 / 4.13.0 | Rule sets `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` |
| Custom in-page checks | `client/e2e/a11y.spec.js` | Everything axe doesn't check, listed in §2 |
| WCAG contrast formula | `client/tests/unit/severityBadgeContrast.test.js` | Severity badge text on its tint, read from `tokens.css` |

**Run it:** from `client/`, run `npx playwright test e2e/a11y.spec.js e2e/keyboard-journey.spec.js`. Both run in the normal `npx playwright test`, so any violation fails the build, as §7.15 requires.

## 2. Automated checks

Each of the seven screens goes through the same seven checks. They're written as one loop over the screens, so a screen added later gets audited just as thoroughly without anyone remembering to do it.

| §7.15 row | Check | Result |
|---|---|---|
| All | axe, WCAG 2.0/2.1/2.2 A + AA, at desktop width and again at 320 px | 0 violations on all 7 |
| Structure | Exactly one `h1`; no skipped heading level; one `main`; `header` + `nav "Primary"` on signed-in screens | Pass on all 7 |
| Language | `<html lang="en">` | Pass |
| Zoom / reflow | No horizontal scroll at 320 px, or at 640 px (a 1280 px window at 200% zoom) | Pass on all 7 |
| Targets | Every control measured at ≥ 24×24 CSS px, both widths. A link inside a sentence is exempt (2.5.8's own exception) | Pass after F3 |
| Keyboard | Tab from the top reaches every tabbable control; **the first stop is the skip link**; every stop shows a focus indicator (outline ≥ 2 px, or a ring) | Pass after F1 |
| Keyboard, 2.4.11 | At 360×480, Tab through the page and then Shift+Tab back. After the smooth scroll settles, no focused control is wholly hidden under the sticky header (checked by what is painted on top, `elementFromPoint`, not by geometry) | Pass after F2 |
| Motion | With `prefers-reduced-motion: reduce`, `document.getAnimations()` has nothing longer than 1 ms and nothing that repeats | Pass on all 7 |

**On the report, from the accessibility tree** (`a11y.spec.js`, "the report as assistive technology receives it"):

- **Findings are a list.** They are four `listitem`s, each with exactly one `h3`, so a reader can jump between findings by heading or by list item.
- **Severity uses words and a shape, never colour alone, including inside the badge.** Each badge contains "High severity", "Medium severity" or "Low severity", plus a distinct shape (●●●, ●●○, ●○○). The shape is `aria-hidden`, so a screen reader hears the words once and not "black circle black circle…".
- **The headings read as a document outline:** the overall risk as `h1`, the four findings as `h3`, and "Protections the contract doesn't include" as an `h2`.

**Contrast:** axe's `color-contrast` rule runs on every rendered screen at both widths. Severity badges get an extra unit test that reads the real colour tokens and applies the WCAG formula, because badges are where designs usually fail (PRD §13).

## 3. Keyboard-only pass

`client/e2e/keyboard-journey.spec.js` runs §7.15's journey, "signup through report to deletion", with **key presses only**. Nothing is clicked, and no element is focused by script. It reaches each control by pressing Tab until the control has focus. If Tab never gets there, the test fails, which is how a keyboard trap or an unreachable control shows up to a person.

The journey: register, then skip link to `main`, then switch to the paste tab with the arrow keys, paste, submit, and watch the analyzing screen. On the report it opens and dismisses a glossary term and copies an ask. It opens the delete dialog, checks that focus stays inside and that Escape returns focus to the trigger, and deletes the contract. Then History, Settings, and account deletion, which lands on `/login` with the deletion notice.

It also checks the moments §7.15 names:

| §7.15 row | Checked | Result |
|---|---|---|
| Progress | The analyzing stages sit in `role="status"` `aria-live="polite"`. **After a stage change, focus is still on the element that had it before** | Pass |
| Copy control | Enter copies the right text. The confirmation is `aria-live="polite"`. Focus stays on the button (now "Copied") | Pass |
| Keyboard | Glossary term: Enter opens it, Escape closes it, and focus stays on the term | Pass |
| Keyboard | Delete dialogs: focus moves in on open, Tab stays inside (a deliberate, escapable modal trap), Escape closes and returns focus to the trigger | Pass |

**What this pass is and isn't.** The key events are real, sent to a real browser, and the result is a full journey with no mouse. But a script presses the keys, not a person. It proves every control can be reached and operated, and that focus goes where it should. It can't judge whether the tab order *feels* sensible, or whether the focus ring is easy to see. The order was read from the sweep logs and matches the visual order on every screen (header, then content top to bottom). The focus ring is the global `:focus-visible` rule: a 2 px brand-colour outline with a 2 px offset.

## 4. Defects found and fixed

| ID | Screens | WCAG / SRS | Blocking | Defect | Fix | Guard |
|---|---|---|---|---|---|---|
| F1 | Every signed-in screen (upload, analyzing, report, history, settings) | 2.4.1 Bypass Blocks | **Yes** | The skip link came **after** the header's four nav links in the DOM. Each page rendered its own skip link, and `App.jsx`'s `Protected` put the header before the page, so a keyboard user had to tab through the navigation before reaching the link that skips it. axe's `skip-link` rule only checks that the target exists, so it passed. | The skip link is rendered once, in `Protected`, before `AppHeader`. The per-page copies are removed. | `a11y.spec.js` "keyboard": the first Tab stop must be the skip link |
| F2 | Settings, report (any long signed-in page) | 2.4.11 Focus Not Obscured (Minimum) | **Yes** | `scroll-padding-top` was a fixed 48 px. The sticky header is 60 px on a desktop and 94 px on a phone, where the nav wraps. At 360×480, Shift+Tab onto "Change password" scrolled it wholly under the header. It was partly covered on a desktop too. | `AppHeader` measures its own height (`ResizeObserver`) and publishes it as `--cc-app-header-height`. `scroll-padding-top` is that height plus a margin. | `a11y.spec.js` "2.4.11". Reverting to the fixed 48 px fails it on report and settings |
| F3 | Report | 2.5.8 per SRS §7.15 | Yes, per the SRS | "Back to history" measured 101×22 px. axe passed it because WCAG 2.5.8 lets a small target through when it has enough space around it. SRS §7.15 says "≥ 24×24" with no such exception, and the SRS is the standard this product committed to. | `min-height: 24px` on the link. | `a11y.spec.js` "targets" |
| F4 (step 74) | Any route reached by an in-app navigation (sign-up → upload, delete → history, …) | 2.4.3 Focus Order | **Yes** | **Introduced by step 74, found the same day.** A route change unmounts the element that had focus, and the browser continues the Tab order from where that element used to be. Until the legal footer existed, nothing came after the page content, so Tab wrapped to the top and the skip link only by luck. With the footer there, a newly signed-up keyboard user's first Tab landed on "Privacy policy" at the bottom of the upload page. | `FocusOnNavigate`: after a navigation in which focus was lost, focus goes back to the top of the document, as on a full page load. Focus a page moves deliberately (a dialog, say) is left alone. | `e2e/keyboard-journey.spec.js`. Mutation-checked: without the fix the journey fails at "Skip to main content"; without its "only when lost" guard, a test fails too. |

Found and fixed earlier in the build, recorded here because they belong to this audit's subject:

- **The unverified-email banner nested a live region inside `role="status"`**, so the resend result was announced twice. Fixed in step 63 (`Banner` gained a silent `role="group"`).
- **The header overflowed a 320 px screen by 26 px** once Settings joined the nav. Fixed in step 63 (the nav wraps on phones).

Every guard above was checked by mutation: the defect was put back, the named test failed, and the file was restored byte-identical. The other guards were checked the same way: removing the reduced-motion rule, dropping `lang`, removing the focus outline, exposing the badge shape to assistive technology, un-listing the findings, stopping the phone nav from wrapping, and moving focus to the current stage on each change. Each one fails its test.

**The legal pages (step 74)** are in the automated audit like every other screen: `/privacy`, `/terms` and `/subprocessors` pass axe at desktop width and at 320 px, reflow without sideways scrolling (wide tables scroll inside a focusable, labelled region), 24 px targets, and keyboard reach. The legal footer on every screen passes the same checks.

## 5. Screen-reader pass: not done, and how to do it

This pass needs a person listening to a real screen reader. The accessibility-tree checks in §2 and §3 establish what the browser *tells* assistive technology. They can't establish what a screen reader *does* with it: announcement order and verbosity, whether a live region is read at all in a given browser and reader pairing, how the glossary popover is read. §7.15 says automated checks catch "roughly a third" of real barriers, and that is why this pass is mandatory.

**Suggested setup:** VoiceOver with Safari on macOS (Cmd+F5 turns it on). If possible, also NVDA with Firefox on Windows, since the two differ in how they handle live regions. Use a fresh account on a local or staging build.

**Script. Listen for each expected result, and record any mismatch as a defect:**

1. **`/register`**: submit the form empty. *Expect:* each error is read with its field, and the field is announced as invalid.
2. **`/` (upload)**: use the rotor or heading navigation (VO+Cmd+H). *Expect:* one `h1`, then the upload content. The skip link is the first thing read on Tab.
3. **Analyzing**: submit a pasted contract and don't touch anything. *Expect:* stage changes are read politely ("Examining the clauses" …) without interrupting other speech, and focus doesn't move.
4. **Report**: navigate by heading. *Expect:* the overall risk first, then each finding's category as a heading. Navigate by list. *Expect:* "list, 4 items". On a finding, *expect* "High severity" (or Medium or Low) to be read as words, not as circles.
5. **Report**: activate "Copy this ask". *Expect:* "Copied. Paste it into your reply to the client." is read, and focus stays on the button.
6. **Report**: open a glossary term. *Expect:* the definition is read, and Escape returns to the term.
7. **Delete dialog** (report, then settings): *Expect:* the dialog's title and description are read on open, you can't wander out of it, and closing returns you to the trigger.
8. **Settings**: *Expect:* four `h2` sections, each announced as a region with its name.
9. **Sign in after a forced sign-out** (change the password in another browser, then use this one). *Expect:* the "You were signed out because your password changed" notice is read.

When it's done, replace this section with what was used (reader, browser, versions), what was heard, and any defects. If a defect is found, it's blocking until fixed.

## 6. Not covered, stated plainly

- **Only Chromium was audited.** Firefox and Safari were not run. That matters most for the screen-reader pass (§5), which needs Safari anyway.
- **Zoom was emulated by viewport width** (320 px, and 640 px for 200%), which is how browsers reflow at those levels. It wasn't done with the browser's zoom control on real devices.
- **Real phones were not tested.** The 24 px targets were measured, not tried with a thumb.
- **1.4.12 Text Spacing** (overriding line, letter and word spacing) was not tested.
- **Forced-colours mode** (Windows High Contrast) was not tested. The severity shapes are text characters, so they should survive it; nobody has checked.
- **There is no dark mode** to audit.
- **Error and empty states** outside the seven screens' default state are covered by axe assertions in the other specs (`auth.spec.js`, `upload.spec.js`, `analyzing.spec.js`, `report.spec.js`, `history.spec.js`, `account.spec.js`, `degraded.spec.js`), not by this file's full set of checks.
