import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { AXE_TAGS, PASTED_CONTRACT, mockApi } from "./support/mockApi.js";

/**
 * BUILD-PLAN step 65: the automated half of the WCAG 2.2 AA audit of the
 * seven core screens (SRS §7.15). docs/accessibility-audit.md records the
 * whole audit, including what automation cannot establish.
 *
 * Every screen gets the same checks, so a screen added later cannot be
 * audited less thoroughly by accident:
 *   - axe, with the WCAG 2.0/2.1/2.2 A and AA rule sets, at desktop width
 *     and again at 320 px;
 *   - structure: one h1, no skipped heading levels, a main landmark (and
 *     header plus nav on the signed-in screens), lang="en";
 *   - reflow: no horizontal scrolling at 320 px, nor at 640 px, which is
 *     what a 1280 px window shows at 200% zoom;
 *   - targets at least 24x24 CSS px (2.5.8), measured, not assumed;
 *   - keyboard: Tab reaches every tabbable element and each one shows a
 *     visible focus indicator (2.4.7 / 2.4.11);
 *   - motion: with prefers-reduced-motion, nothing animates.
 */

/**
 * @typedef {{
 *   name: string,
 *   signedIn: boolean,
 *   appChrome: boolean,
 *   open: (page: import("@playwright/test").Page) => Promise<void>,
 *   analyze?: "complete" | "hang",
 * }} Screen
 */

/** @type {Screen[]} */
const SCREENS = [
  {
    name: "login",
    signedIn: false,
    appChrome: false,
    open: async (page) => {
      await page.goto("/login");
      await expect(
        page.getByRole("heading", { level: 1, name: "Sign in" }),
      ).toBeVisible();
    },
  },
  {
    name: "register",
    signedIn: false,
    appChrome: false,
    open: async (page) => {
      await page.goto("/register");
      await expect(
        page.getByRole("heading", { level: 1, name: "Create your account" }),
      ).toBeVisible();
    },
  },
  {
    name: "upload",
    signedIn: true,
    appChrome: true,
    open: async (page) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    name: "analyzing",
    signedIn: true,
    appChrome: true,
    analyze: "hang",
    open: async (page) => {
      await page.goto("/");
      await page.getByRole("tab", { name: "Paste the text" }).click();
      await page.getByLabel("Paste the contract text").fill(PASTED_CONTRACT);
      await page.getByRole("button", { name: "Check this contract" }).click();
      await expect(page.getByText("Reading the document")).toBeVisible();
    },
  },
  {
    name: "report",
    signedIn: true,
    appChrome: true,
    open: async (page) => {
      await page.goto("/documents/doc1");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator("ol.cc-report__findings > li")).toHaveCount(4);
    },
  },
  {
    name: "history",
    signedIn: true,
    appChrome: true,
    open: async (page) => {
      await page.goto("/documents");
      await expect(page.getByText("msa-freelance.pdf")).toBeVisible();
    },
  },
  {
    name: "settings",
    signedIn: true,
    appChrome: true,
    open: async (page) => {
      await page.goto("/settings");
      await expect(
        page.getByRole("heading", { level: 1, name: "Settings" }),
      ).toBeVisible();
    },
  },
  // Step 75: a signed-in person opening the app while the database is
  // down. The session check answers 503, and the screen says so instead
  // of sending them to sign in.
  {
    name: "session-unavailable",
    signedIn: true,
    appChrome: false,
    open: async (page) => {
      await page.route("**/api/v1/auth/me", (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          headers: {
            "Retry-After": "30",
            "Access-Control-Expose-Headers": "Retry-After",
          },
          body: JSON.stringify({
            error: {
              code: "DATABASE_UNAVAILABLE",
              message:
                "We can't reach your saved contracts and reports for a moment. Nothing has been lost. Try again in a minute.",
              requestId: "r",
            },
          }),
        }),
      );
      await page.goto("/documents");
      await expect(
        page.getByRole("heading", { level: 1, name: /can’t be reached/ }),
      ).toBeVisible();
    },
  },
  // Step 75: FR-1.13's confirmation screen, opened from a mailbox, often
  // signed out.
  {
    name: "confirm-email-change",
    signedIn: false,
    appChrome: false,
    open: async (page) => {
      await page.goto("/confirm-email-change?token=e2e-token");
      await expect(
        page.getByRole("heading", { level: 1, name: "Email changed" }),
      ).toBeVisible();
    },
  },
  // Step 74: the legal surface, public and held to the same audit. Long
  // text and wide tables are exactly where 320 px reflow breaks.
  ...[
    ["privacy", "Privacy policy"],
    ["terms", "Terms of service"],
    ["subprocessors", "Subprocessors"],
  ].map(
    ([slug, title]) =>
      /** @type {Screen} */ ({
        name: slug,
        signedIn: false,
        appChrome: false,
        open: async (page) => {
          await page.goto(`/${slug}`);
          await expect(
            page.getByRole("heading", { level: 1, name: title }),
          ).toBeVisible();
        },
      }),
  ),
];

/** @param {import("@playwright/test").Page} page */
async function axeViolations(page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  // Only what a reader needs to find the problem.
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    targets: v.nodes.map((n) => n.target.join(" ")),
  }));
}

/** @param {import("@playwright/test").Page} page */
function horizontalOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/**
 * Interactive elements smaller than 24x24 CSS px. The one exception 2.5.8
 * itself makes and this applies: a link inside a sentence ("inline"),
 * whose size is set by the line of text around it.
 *
 * @param {import("@playwright/test").Page} page
 */
function undersizedTargets(page) {
  return page.evaluate(() => {
    const selector =
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="tab"], [tabindex]:not([tabindex="-1"])';
    /** @type {string[]} */
    const small = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!(el instanceof HTMLElement) || !el.checkVisibility()) continue;
      const rect = el.getBoundingClientRect();
      // Visually hidden controls (the file input, the skip link before it
      // is focused) are not targets anyone can point at.
      if (rect.width <= 1 || rect.height <= 1) continue;
      const style = getComputedStyle(el);
      if (el.tagName === "A" && style.display === "inline") continue;
      if (rect.width < 24 || rect.height < 24) {
        small.push(
          `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        );
      }
    }
    return small;
  });
}

/** @param {import("@playwright/test").Page} page */
function headingProblems(page) {
  return page.evaluate(() => {
    const levels = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")]
      .filter((h) => h instanceof HTMLElement && h.checkVisibility())
      .map((h) => Number(h.tagName[1]));
    /** @type {string[]} */
    const problems = [];
    const h1s = levels.filter((l) => l === 1).length;
    if (h1s !== 1) problems.push(`${h1s} h1 elements`);
    if (levels[0] !== 1) problems.push(`first heading is h${levels[0]}`);
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i] > levels[i - 1] + 1)
        problems.push(`h${levels[i - 1]} then h${levels[i]}`);
    }
    return problems;
  });
}

/**
 * Tabs through the page once, from the top. Returns every stop that had
 * no visible focus indicator, and whether Tab reached every tabbable
 * element (a trap, or an unreachable control, fails that).
 *
 * @param {import("@playwright/test").Page} page
 */
async function keyboardSweep(page) {
  const tabbable = await page.evaluate(
    () =>
      [
        ...document.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter(
        (el) =>
          el instanceof HTMLElement &&
          el.tabIndex >= 0 &&
          // A visually hidden element is still tabbable (the skip link).
          (el.checkVisibility() || el.classList.contains("cc-skip-link")) &&
          // Only one tab of a tablist is in the Tab order (roving tabindex).
          !(
            el.getAttribute("role") === "tab" &&
            el.getAttribute("aria-selected") !== "true"
          ),
      ).length,
  );

  // Start from the very top of the document. Blurring is not enough: the
  // browser keeps a "sequential focus navigation starting point" where the
  // last focused element was, so a sweep that begins after a click starts
  // halfway down the page. Focusing a non-tabbable marker at the top of
  // <body> resets it.
  await page.evaluate(() => {
    const marker = document.createElement("div");
    marker.id = "audit-start";
    marker.tabIndex = -1;
    document.body.prepend(marker);
    marker.focus();
    window.scrollTo(0, 0);
  });

  /** @type {string[]} */
  const order = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const noIndicator = [];
  for (let i = 0; i < tabbable + 5; i += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      if (!el.hasAttribute("data-audit-id")) {
        el.setAttribute("data-audit-id", String(Math.random()));
      }
      const style = getComputedStyle(el);
      const outline =
        style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
      const ring = style.boxShadow !== "none";
      return {
        id: /** @type {string} */ (el.getAttribute("data-audit-id")),
        label: `${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 40)}"`,
        visible: outline || ring,
      };
    });
    if (!stop) break;
    if (seen.has(stop.id)) break; // wrapped around
    seen.add(stop.id);
    order.push(stop.label);
    if (!stop.visible) noIndicator.push(stop.label);
  }
  await page.evaluate(() => document.getElementById("audit-start")?.remove());
  return { reached: seen.size, tabbable, noIndicator, first: order[0] };
}

/**
 * WCAG 2.2's 2.4.11 Focus Not Obscured (Minimum): a focused control must
 * not be ENTIRELY hidden by author content, here the sticky app header.
 * Tabs forward through the page and then back (Shift+Tab is where a
 * sticky header usually bites: the browser scrolls the control to the
 * top edge, under the header), recording every stop that sits wholly
 * behind it.
 *
 * @param {import("@playwright/test").Page} page
 */
async function obscuredStops(page) {
  /** @type {string[]} */
  const obscured = [];
  const check = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      const header = document.querySelector(".cc-app-header");
      if (!el || el === document.body || !header || header.contains(el)) return null;
      // What is actually painted on top, not geometry: sample the corners
      // and centre, and call it hidden only if the header wins at every
      // one ("entirely hidden" is the 2.4.11 threshold). Stacking order
      // matters: a skip link drawn above the header is not obscured by
      // it however much the two overlap.
      const r = el.getBoundingClientRect();
      const inset = 2;
      const points = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + inset, r.top + inset],
        [r.right - inset, r.top + inset],
        [r.left + inset, r.bottom - inset],
        [r.right - inset, r.bottom - inset],
      ];
      const hidden = points.every(([x, y]) => {
        const top = document.elementFromPoint(x, y);
        return top !== null && header.contains(top) && !el.contains(top);
      });
      return hidden
        ? `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}"`
        : null;
    });
  // Focus scrolling is smooth (global.css), so measure only once the page
  // has stopped moving: three animation frames with the same scroll
  // position. Measuring mid-scroll reports positions no one ever sees.
  const settled = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          let last = -1;
          let still = 0;
          const started = performance.now();
          const tick = () => {
            if (scrollY === last) still += 1;
            else still = 0;
            last = scrollY;
            if (still >= 3 || performance.now() - started > 3000) resolve(undefined);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press(key);
      await settled();
      const hit = await check();
      if (hit) obscured.push(`${key}: ${hit}`);
    }
  }
  return [...new Set(obscured)];
}

for (const screen of SCREENS) {
  test.describe(`${screen.name} (SRS §7.15)`, () => {
    test.beforeEach(async ({ page }) => {
      await mockApi(page, { signedIn: screen.signedIn, analyze: screen.analyze });
    });

    test("axe: zero WCAG 2.2 AA violations at desktop width", async ({ page }) => {
      await screen.open(page);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("structure: one h1, no skipped levels, landmarks, lang", async ({ page }) => {
      await screen.open(page);
      expect(await headingProblems(page)).toEqual([]);
      await expect(page.getByRole("main")).toHaveCount(1);
      if (screen.appChrome) {
        await expect(page.getByRole("banner")).toHaveCount(1);
        await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.lang)).toBe("en");
    });

    test("reflow: no horizontal scroll at 320 px or at 200% zoom, and axe-clean at 320 px", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 720 });
      await screen.open(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);

      // 200% zoom of a 1280 px window lays out as 640 CSS px.
      await page.setViewportSize({ width: 640, height: 400 });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test("targets: every control is at least 24x24 CSS px (2.5.8)", async ({ page }) => {
      await screen.open(page);
      expect(await undersizedTargets(page)).toEqual([]);
      await page.setViewportSize({ width: 320, height: 720 });
      expect(await undersizedTargets(page)).toEqual([]);
    });

    test("keyboard: 2.4.11, no focused control is hidden under the sticky header, forwards or backwards", async ({
      page,
    }) => {
      // Many stops, each waiting for smooth scrolling to settle.
      test.setTimeout(120_000);
      // Short and narrow: the case where a sticky header covers the most.
      await page.setViewportSize({ width: 360, height: 480 });
      await screen.open(page);
      expect(await obscuredStops(page)).toEqual([]);
    });

    test("keyboard: Tab reaches every control, each with a visible focus indicator", async ({
      page,
    }) => {
      await screen.open(page);
      const sweep = await keyboardSweep(page);
      // 2.4.1: the skip link is the FIRST stop, before any navigation it
      // exists to skip.
      expect(sweep.first).toBe('a "Skip to main content"');
      expect(sweep.noIndicator).toEqual([]);
      expect(sweep.reached).toBe(sweep.tabbable);
    });

    test("motion: with prefers-reduced-motion, nothing animates", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await screen.open(page);
      const moving = await page.evaluate(
        () =>
          document
            .getAnimations()
            .map((a) => a.effect?.getComputedTiming())
            .filter(
              (t) =>
                t &&
                (Number(t.duration) > 1 ||
                  t.iterations === Infinity ||
                  Number(t.iterations) > 1),
            ).length,
      );
      expect(moving).toBe(0);
    });
  });
}

test.describe("the report as assistive technology receives it (SRS §7.15, PRD §13)", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto("/documents/doc1");
    await expect(page.locator("ol.cc-report__findings > li")).toHaveCount(4);
  });

  test("findings are a list of items, each with its own heading, so a reader can skip between them", async ({
    page,
  }) => {
    const list = page
      .getByRole("main")
      .getByRole("list")
      .filter({ has: page.locator("li h3") });
    await expect(list.getByRole("listitem")).toHaveCount(4);
    for (const item of await list.getByRole("listitem").all()) {
      await expect(item.getByRole("heading", { level: 3 })).toHaveCount(1);
    }
  });

  test("severity is in words and in a shape, never colour alone, including inside the badge", async ({
    page,
  }) => {
    const items = page.locator("ol.cc-report__findings > li");
    const expected = [
      ["High severity", "●●●"],
      ["High severity", "●●●"],
      ["Medium severity", "●●○"],
      ["Low severity", "●○○"],
    ];
    for (const [index, [words, shape]] of expected.entries()) {
      const badge = items.nth(index).locator(".cc-severity-badge").first();
      await expect(badge).toContainText(words);
      // The shape is visible to sight and hidden from a screen reader,
      // which gets the words instead: neither channel depends on colour.
      const mark = badge.locator(".cc-severity-badge__mark");
      await expect(mark).toHaveText(shape);
      await expect(mark).toHaveAttribute("aria-hidden", "true");
    }
  });

  test("the heading outline reads as a document: overall risk, the findings, then what is missing", async ({
    page,
  }) => {
    const outline = await page
      .getByRole("main")
      .evaluate((main) =>
        [...main.querySelectorAll("h1, h2, h3")].map(
          (h) => `${h.tagName}:${(h.textContent ?? "").trim().slice(0, 40)}`,
        ),
      );
    expect(outline[0]).toMatch(/^H1:/);
    expect(outline.filter((h) => h.startsWith("H3:"))).toHaveLength(4);
    expect(outline.some((h) => h === "H2:Protections the contract doesn’t include")).toBe(
      true,
    );
  });
});
