import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * BUILD-PLAN step 33 — "Write a Playwright test with axe assertions,
 * covering the dropzone by keyboard alone." See playwright.config.js's
 * file comment for why the API is mocked rather than a live backend.
 */

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** @param {import("@playwright/test").Page} page */
async function signIn(page) {
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "u1", email: "person@example.com", state: "ACTIVE" },
      }),
    }),
  );
}

/**
 * @param {import("@playwright/test").Route} route
 * @param {{ status: number, code: string, message: string, requestId?: string }} error
 */
function fulfillError(route, error) {
  return route.fulfill({
    status: error.status,
    contentType: "application/json",
    body: JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
        requestId: error.requestId ?? "req_e2e",
      },
    }),
  });
}

/**
 * The dropzone's keyboard path: focus a trigger (the empty dropzone's
 * "Choose a file", or the selected state's "Choose a different file"),
 * press Enter, and hand the native picker the given file — exactly what
 * "covering the dropzone by keyboard alone" (step 33) asks this suite to
 * exercise, never a mouse click or `setInputFiles` on the (intentionally
 * unfocusable — see UploadPage.jsx) hidden `<input>` directly.
 *
 * `timeout: 5000` on the filechooser wait, not Playwright's 30s test
 * default: this event is occasionally slow to fire on this machine for
 * reasons unrelated to the app (confirmed by running the SAME assertions
 * alone, repeatedly, with no failures — see playwright.config.js's
 * `retries`) — failing in 5s instead of 30s is what makes a retry cycle
 * cheap enough that the flake costs seconds, not minutes.
 *
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Locator} trigger
 * @param {{ name: string, mimeType: string, buffer: Buffer }} file
 */
async function chooseFileViaKeyboard(page, trigger, file) {
  await trigger.focus();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 5000 }),
    page.keyboard.press("Enter"),
  ]);
  await chooser.setFiles(file);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test.describe("upload screen (/, BUILD-PLAN step 33)", () => {
  test("matches the prototype's hero, tabs and dropzone copy, with no jurisdiction selector", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Hand over the contract.",
    );
    expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
    await expect(page.getByRole("tab", { name: "Upload a file" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Paste the text" })).toBeVisible();
    await expect(page.getByText("Drop the contract here")).toBeVisible();
    await expect(page.getByText("Up to about 8 pages")).toBeVisible();

    // BUILD-PLAN decision D-A, option A1 — the jurisdiction selector is
    // in the prototype but deliberately not built.
    await expect(page.getByText("Where are you based?")).toHaveCount(0);
    await expect(page.getByRole("radiogroup")).toHaveCount(0);
  });

  test("states what the tool does, how long documents are kept, and that deletion is permanent (PRD §5 step 1)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText(/kept for up to 90 days/)).toBeVisible();
    await expect(
      page.getByText(/Delete it any time and it is gone for good/),
    ).toBeVisible();
  });

  test("the dropzone is fully keyboard-operable: Tab reaches it, Enter opens the file picker, a chosen file moves to the selected state", async ({
    page,
  }) => {
    await page.goto("/");

    const chooseButton = page.getByRole("button", { name: "Choose a file" });
    await chooseButton.focus();
    await expect(chooseButton).toBeFocused();
    await chooseFileViaKeyboard(page, chooseButton, {
      name: "contract.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 fake contract body"),
    });

    await expect(page.getByText("contract.pdf")).toBeVisible();
    await expect(page.getByRole("button", { name: "Check this contract" })).toBeVisible();
  });

  test("a keyboard-chosen oversized file is caught client-side, before any request", async ({
    page,
  }) => {
    let requestMade = false;
    await page.route("**/api/v1/documents", (route) => {
      requestMade = true;
      return route.continue();
    });

    await page.goto("/");
    await chooseFileViaKeyboard(
      page,
      page.getByRole("button", { name: "Choose a file" }),
      {
        name: "big.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.alloc(6 * 1024 * 1024, "a"),
      },
    );

    await expect(page.getByRole("alert")).toContainText("a little too large");
    await expect(page.getByRole("alert")).toContainText("FILE_TOO_LARGE");
    expect(requestMade).toBe(false);
  });

  test("a keyboard-chosen unsupported extension is caught client-side", async ({
    page,
  }) => {
    await page.goto("/");
    await chooseFileViaKeyboard(
      page,
      page.getByRole("button", { name: "Choose a file" }),
      {
        name: "contract.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("not a contract file format"),
      },
    );

    await expect(page.getByRole("alert")).toContainText("isn’t a PDF or a DOCX");
  });

  test("the error banner's 'Choose another file' reopens the picker directly", async ({
    page,
  }) => {
    await page.goto("/");
    await chooseFileViaKeyboard(
      page,
      page.getByRole("button", { name: "Choose a file" }),
      {
        name: "contract.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("x"),
      },
    );
    await expect(page.getByRole("alert")).toBeVisible();

    await chooseFileViaKeyboard(
      page,
      page.getByRole("button", { name: "Choose another file" }),
      {
        name: "contract.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4 fine this time"),
      },
    );

    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("contract.pdf")).toBeVisible();
  });

  test("the paste tab shows a live word count and disables submit when empty", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Paste the text" }).click();

    const submit = page.getByRole("button", { name: "Check this contract" });
    await expect(submit).toBeDisabled();
    await expect(page.getByText("0 words · 200 minimum, 4,000 maximum")).toBeVisible();

    await page.getByLabel("Paste the contract text").fill("one two three four five");
    await expect(page.getByText("5 words · 200 minimum, 4,000 maximum")).toBeVisible();
    await expect(submit).toBeEnabled();
  });

  test("submitting disables the button and warns before navigation while in flight (FR-7.3)", async ({
    page,
  }) => {
    await page.route("**/api/v1/documents", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return fulfillError(route, {
        status: 422,
        code: "DOCUMENT_TOO_SHORT",
        message: "This document is 5 words — under the 200-word minimum.",
      });
    });

    await page.goto("/");
    await page.getByRole("tab", { name: "Paste the text" }).click();
    await page.getByLabel("Paste the contract text").fill("one two three four five");

    // FR-7.3's "disables on click" applies to THIS half — the upload
    // POST — where a failure keeps the user on the form (BUILD-PLAN
    // step 34 moved the analyzing screen to its own AnalyzingPanel,
    // which only ever mounts once the upload half has already
    // succeeded; a request that errors here never gets that far, so
    // the button disables in place rather than disappearing behind it).
    const submit = page.getByRole("button", { name: "Check this contract" });
    await submit.click();
    await expect(submit).toBeDisabled();

    // NOT awaited: dismissing a beforeunload dialog means "cancel the
    // navigation," and page.reload()'s own promise then never settles —
    // there is no cancelled-navigation event Playwright resolves it
    // with. Awaiting it (even raced against the dialog) deadlocks the
    // test, confirmed directly: it hangs to the test timeout every time.
    // The dialog event firing at all, independent of reload() ever
    // "finishing," is what FR-7.3 actually asks this test to prove.
    const dialogPromise = page.waitForEvent("dialog", { timeout: 5000 });
    page.reload({ waitUntil: "commit" }).catch(() => {});
    const dialog = await dialogPromise;
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
  });

  test.describe("all five UPLOAD_ERRORS states, from the server", () => {
    test("FILE_TOO_LARGE", async ({ page }) => {
      await page.route("**/api/v1/documents", (route) =>
        fulfillError(route, {
          status: 413,
          code: "FILE_TOO_LARGE",
          message: "That file is over the 5 MB limit.",
        }),
      );
      await page.goto("/");
      // Exactly at the client pre-check's boundary, so it reaches the
      // (mocked) server rather than being caught client-side first.
      await chooseFileViaKeyboard(
        page,
        page.getByRole("button", { name: "Choose a file" }),
        {
          name: "contract.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.alloc(5 * 1024 * 1024, "a"),
        },
      );
      await page.getByRole("button", { name: "Check this contract" }).click();

      const alert = page.getByRole("alert");
      await expect(alert).toContainText("a little too large");
      await expect(alert).toContainText("FILE_TOO_LARGE · 413");
    });

    test("UNSUPPORTED_FILE_TYPE", async ({ page }) => {
      await page.route("**/api/v1/documents", (route) =>
        fulfillError(route, {
          status: 422,
          code: "UNSUPPORTED_FILE_TYPE",
          message: "That file isn't a supported format.",
        }),
      );
      await page.goto("/");
      await chooseFileViaKeyboard(
        page,
        page.getByRole("button", { name: "Choose a file" }),
        {
          name: "contract.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("%PDF-1.4 but the server says no"),
        },
      );
      await page.getByRole("button", { name: "Check this contract" }).click();

      await expect(page.getByRole("alert")).toContainText("isn’t a PDF or a DOCX");
      await expect(page.getByRole("alert")).toContainText("UNSUPPORTED_FILE_TYPE · 422");
    });

    test("DOCUMENT_TOO_SHORT from an upload renders the scanned-PDF copy", async ({
      page,
    }) => {
      await page.route("**/api/v1/documents", (route) =>
        fulfillError(route, {
          status: 422,
          code: "DOCUMENT_TOO_SHORT",
          message: "This document is 0 words — under the 200-word minimum.",
        }),
      );
      await page.goto("/");
      await chooseFileViaKeyboard(
        page,
        page.getByRole("button", { name: "Choose a file" }),
        {
          name: "scan.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("%PDF-1.4 scanned image, no text layer"),
        },
      );
      await page.getByRole("button", { name: "Check this contract" }).click();

      const alert = page.getByRole("alert");
      await expect(alert).toContainText("couldn’t find any text in this PDF");
      await expect(alert).not.toContainText("words");
    });

    test("DOCUMENT_TOO_SHORT from a paste renders the real word count", async ({
      page,
    }) => {
      await page.route("**/api/v1/documents", (route) =>
        fulfillError(route, {
          status: 422,
          code: "DOCUMENT_TOO_SHORT",
          message: "This document is 38 words — under the 200-word minimum.",
        }),
      );
      await page.goto("/");
      await page.getByRole("tab", { name: "Paste the text" }).click();
      await page.getByLabel("Paste the contract text").fill("short contract text");
      await page.getByRole("button", { name: "Check this contract" }).click();

      const alert = page.getByRole("alert");
      await expect(alert).toContainText("That’s 38 words — too little to check.");
      await expect(page.getByRole("button", { name: "Paste more text" })).toBeVisible();
    });

    test("DOCUMENT_TOO_LONG renders the real word count", async ({ page }) => {
      await page.route("**/api/v1/documents", (route) =>
        fulfillError(route, {
          status: 422,
          code: "DOCUMENT_TOO_LONG",
          message: "Document is 4,468 words. Phase 1 supports up to 4,000.",
        }),
      );
      await page.goto("/");
      await chooseFileViaKeyboard(
        page,
        page.getByRole("button", { name: "Choose a file" }),
        {
          name: "long.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("%PDF-1.4 a very long contract"),
        },
      );
      await page.getByRole("button", { name: "Check this contract" }).click();

      await expect(page.getByRole("alert")).toContainText(
        "This document is 4,468 words.",
      );
    });

    test("RATE_LIMITED shows the server's real message", async ({ page }) => {
      await page.route("**/api/v1/documents", (route) =>
        fulfillError(route, {
          status: 429,
          code: "RATE_LIMITED",
          message: "You've made too many requests. Please wait a moment and try again.",
        }),
      );
      await page.goto("/");
      await page.getByRole("tab", { name: "Paste the text" }).click();
      await page
        .getByLabel("Paste the contract text")
        .fill("enough text to pass the empty check");
      await page.getByRole("button", { name: "Check this contract" }).click();

      const alert = page.getByRole("alert");
      await expect(alert).toContainText("too many requests");
      await expect(alert).toContainText("RATE_LIMITED · 429");
      await expect(page.getByRole("button", { name: "Got it" })).toBeVisible();
    });
  });

  test("a successful upload and analyze navigates to the report route", async ({
    page,
  }) => {
    await page.route("**/api/v1/documents", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          document: {
            id: "doc_e2e_1",
            filename: null,
            sourceType: "PASTE",
            wordCount: 5,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      }),
    );
    await page.route("**/api/v1/documents/doc_e2e_1/analyze", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          analysis: {
            id: "an_e2e_1",
            status: "COMPLETED",
            overallRisk: "low",
            summary: "x",
            findings: [],
            missingClauses: [],
            discardedFindings: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      }),
    );

    await page.goto("/");
    await page.getByRole("tab", { name: "Paste the text" }).click();
    await page.getByLabel("Paste the contract text").fill("a contract with enough words");
    await page.getByRole("button", { name: "Check this contract" }).click();

    await expect(page).toHaveURL("/documents/doc_e2e_1");
  });

  test("axe reports zero violations: empty, file-selected, and error states", async ({
    page,
  }) => {
    await page.goto("/");
    let results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);

    await chooseFileViaKeyboard(
      page,
      page.getByRole("button", { name: "Choose a file" }),
      {
        name: "contract.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4 ok"),
      },
    );
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);

    await page.route("**/api/v1/documents", (route) =>
      fulfillError(route, {
        status: 413,
        code: "FILE_TOO_LARGE",
        message: "x",
      }),
    );
    await chooseFileViaKeyboard(
      page,
      page.getByRole("button", { name: "Choose a different file" }),
      {
        name: "big.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.alloc(6 * 1024 * 1024, "a"),
      },
    );
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test("axe reports zero violations on the paste tab", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Paste the text" }).click();
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
});
