import { test, expect } from "@playwright/test";
import { mockApi } from "./support/mockApi.js";

/**
 * BUILD-PLAN step 66 switched the three families to variable fonts, whose
 * family names differ from the static ones ("Geist Variable", not "Geist
 * Sans"; the sans is Host Grotesk since the redesign after step 75). A name in tokens.css that matches no @font-face does not error:
 * the browser silently falls back to the system font and every other test
 * still passes. This checks that each family actually loads and is the
 * one the text renders in. (That the body font is PRELOADED is checked
 * against the production build by scripts/check-bundle-size.mjs.)
 */

test("each family loads and is used where it should be, on the report", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/documents/doc1");
  await expect(page.locator("ol.cc-report__findings > li")).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);

  const faces = await page.evaluate(() =>
    [...document.fonts]
      .filter((f) => f.status === "loaded")
      .map((f) => f.family.replaceAll('"', "")),
  );
  // Geist Mono is not among them, and that is the design rather than a
  // gap: since the redesign after step 75 it sets codes only (an error
  // code, a request id), and a completed report shows none.
  expect(new Set(faces)).toEqual(new Set(["Host Grotesk Variable", "Literata Variable"]));

  const familyOf = (selector) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
  // The report's h1 is the overall risk word, which is Literata by design
  // (fonts.js); the findings' headings are the app's voice.
  expect(await familyOf("h1")).toMatch(/^"?Literata Variable"?,/);
  expect(await familyOf("h3")).toMatch(/^"?Host Grotesk Variable"?,/);
  expect(await familyOf("blockquote")).toMatch(/^"?Literata Variable"?,/);
});
