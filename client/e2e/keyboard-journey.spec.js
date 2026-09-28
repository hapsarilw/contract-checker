import { test, expect } from "@playwright/test";
import { ANALYSIS, FINDINGS, PASTED_CONTRACT, mockApi } from "./support/mockApi.js";

/**
 * BUILD-PLAN step 65: the keyboard-only pass over the whole journey,
 * "signup through report to deletion. No mouse." Every action below is a
 * key press; nothing is clicked, and no element is focused by script.
 * `tabTo` presses Tab until the wanted control has focus, and fails if it
 * never does, which is exactly how a keyboard trap or an unreachable
 * control shows up to a person.
 *
 * Along the way it checks what a screen reader is TOLD at the moments
 * §7.15 names: the analyzing screen's progress is a polite status region
 * and never takes focus; the copy confirmation is announced politely
 * while focus stays on the button; dialogs take focus in and give it back.
 * That is the accessibility tree, not a screen reader: the audit document
 * says what a real screen-reader pass would add and that it is still owed.
 */

/**
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Locator} target
 * @param {{ max?: number }} [options]
 */
async function tabTo(page, target, { max = 60 } = {}) {
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${target}: unreachable, or a keyboard trap`);
}

test("keyboard only: register, paste, analyze, read and copy, delete the contract, delete the account", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApi(page, { signedIn: false });

  // The analyze call is held until the test has inspected the analyzing
  // screen, then released.
  /** @type {() => void} */
  let releaseAnalyze = () => {};
  const analyzeReleased = new Promise((resolve) => {
    releaseAnalyze = () => resolve(undefined);
  });
  await page.route("**/api/v1/documents/doc1/analyze", async (route) => {
    await analyzeReleased;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ analysis: ANALYSIS }),
    });
  });

  // --- Register ---------------------------------------------------------
  await page.goto("/register");
  await tabTo(page, page.getByLabel("Email"));
  await page.keyboard.type("person@example.com");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
  await page.keyboard.type("a-long-enough-password");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/");

  // --- Upload, by pasting -----------------------------------------------
  // The skip link is the first stop and lands in main, past the nav.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();

  await tabTo(page, page.getByRole("tab", { name: "Upload a file" }));
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Paste the text" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Paste the text" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await tabTo(page, page.getByLabel("Paste the contract text"));
  await page.keyboard.insertText(PASTED_CONTRACT);
  await tabTo(page, page.getByRole("button", { name: "Check this contract" }));
  await page.keyboard.press("Enter");

  // --- Analyzing: announced politely, focus left alone -------------------
  const progress = page.locator(".cc-analyzing__stages");
  await expect(progress).toHaveAttribute("role", "status");
  await expect(progress).toHaveAttribute("aria-live", "polite");
  // Mark whatever has focus now, and check the same element still has it
  // after the stage changes (identity, not markup: body's markup changes
  // with every stage).
  await page.evaluate(() => document.activeElement?.setAttribute("data-focus-mark", ""));
  await expect(progress).toContainText("Reading the document");
  // Past the first stage change (every 7.5 s), focus must not have moved.
  await expect(progress.locator('[aria-current="step"]')).not.toContainText(
    "Reading the document",
    { timeout: 12_000 },
  );
  expect(
    await page.evaluate(
      () => document.activeElement?.hasAttribute("data-focus-mark") ?? false,
    ),
  ).toBe(true);
  releaseAnalyze();
  await expect(page).toHaveURL("/documents/doc1");

  // --- Report: a document, navigable, with its controls by keyboard ------
  await expect(page.locator("ol.cc-report__findings > li")).toHaveCount(FINDINGS.length);

  // A glossary term opens with Enter and closes with Escape, keeping focus.
  const term = page.getByRole("button", { name: "indemnity" });
  await tabTo(page, term);
  await page.keyboard.press("Enter");
  const meaning = page.getByText(
    "A promise to cover the other side’s losses if a claim is made against them.",
  );
  await expect(meaning).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(meaning).toBeHidden();
  await expect(term).toBeFocused();

  // Copy: announced politely, focus stays on the control.
  const firstCard = page.locator("ol.cc-report__findings > li").first();
  await tabTo(page, firstCard.getByRole("button", { name: "Copy this ask" }));
  await page.keyboard.press("Enter");
  await expect(firstCard.getByRole("button", { name: "Copied" })).toBeFocused();
  const note = firstCard.getByText("Copied. Paste it into your reply to the client.");
  await expect(note).toHaveAttribute("aria-live", "polite");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    FINDINGS[0].suggestedChange,
  );

  // Delete the contract: the dialog takes focus in, Escape gives it back.
  const deleteTrigger = page.getByRole("button", { name: "Delete permanently" });
  await tabTo(page, deleteTrigger);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  // Tab stays inside the modal (a deliberate, escapable trap).
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(deleteTrigger).toBeFocused();

  await page.keyboard.press("Enter");
  await tabTo(page, dialog.getByRole("button", { name: "Delete permanently" }), {
    max: 6,
  });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/documents");
  await expect(page.getByText("No contracts checked yet.")).toBeVisible();

  // --- Settings: delete the account --------------------------------------
  await tabTo(page, page.getByRole("link", { name: "Settings" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await tabTo(page, page.getByRole("button", { name: "Delete my account…" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await tabTo(page, page.getByLabel("Enter your password to confirm"), { max: 6 });
  await page.keyboard.type("a-long-enough-password");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/login\?reason=account_deleted/);
  await expect(page.getByText("Your account was deleted")).toBeVisible();
});
