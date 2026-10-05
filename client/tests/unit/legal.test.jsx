import { readFileSync } from "node:fs";
import process from "node:process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import App from "../../src/App.jsx";
import LegalPage from "../../src/pages/LegalPage.jsx";
import { AuthContext } from "../../src/auth/AuthContext.js";
import { I18nProvider } from "../../src/i18n/index.js";
import {
  LEGAL_DOCUMENTS,
  privacy,
  subprocessors,
  unresolved,
} from "../../src/legal/content.js";

/**
 * BUILD-PLAN step 74: the legal surface (PRD §12). Each document is
 * reachable signed out, linked from every layout and from the upload
 * screen, honest about being a draft while it is one, and consistent
 * with the verification record its provider claims rest on.
 */

vi.mock("../../src/api/client.js", async (importOriginal) => {
  const actual = /** @type {object} */ (await importOriginal());
  return { ...actual, apiFetch: vi.fn(() => new Promise(() => {})) };
});

/** @param {{ path: string, status?: "authenticated" | "unauthenticated" }} options */
function renderApp({ path, status = "unauthenticated" }) {
  const value = {
    status,
    user:
      status === "authenticated" ? { id: "u1", email: "a@b.com", state: "ACTIVE" } : null,
    setUser: () => {},
    signOut: () => {},
  };
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[path]}>
        <AuthContext.Provider value={value}>
          <App />
        </AuthContext.Provider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

const legalLinks = () => {
  const nav = screen.getByRole("navigation", { name: "Legal" });
  return within(nav)
    .getAllByRole("link")
    .map((a) => a.getAttribute("href"));
};

describe("the legal pages", () => {
  it.each(Object.values(LEGAL_DOCUMENTS))(
    "$slug is public: it renders signed out",
    (doc) => {
      renderApp({ path: `/${doc.slug}` });
      expect(
        screen.getByRole("heading", { level: 1, name: doc.title }),
      ).toBeInTheDocument();
      expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(
        doc.sections.length,
      );
    },
  );

  it("says it is a draft, and what is missing, while any placeholder remains", () => {
    renderApp({ path: "/privacy" });
    const draft = screen.getByText("Draft: not yet in force").closest(".cc-banner");
    expect(draft).not.toBeNull();
    expect(
      within(/** @type {HTMLElement} */ (draft)).getByText("operator"),
    ).toBeInTheDocument();
    expect(unresolved(privacy)).toContain("[OPERATOR]");
  });

  it("drops the draft notice by itself once nothing is left to fill in", () => {
    const finished = {
      slug: "finished",
      title: "Finished",
      summary: "No placeholders.",
      sections: [{ heading: "One", blocks: ["Complete text."] }],
    };
    expect(unresolved(finished)).toEqual([]);
    render(
      <MemoryRouter>
        <LegalPage doc={finished} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Draft: not yet in force")).toBeNull();
  });

  it("lists every subprocessor PRD §12.3 names", () => {
    const rows = /** @type {{ table: { rows: string[][] } }} */ (
      subprocessors.sections[0].blocks[0]
    ).table.rows;
    const text = rows.map((r) => r.join(" ")).join("\n");
    // The LLM, hosting, database, email and error-tracking providers.
    for (const role of ["Anthropic", "HOSTING", "DATABASE", "EMAIL", "Sentry"]) {
      expect(text).toContain(role);
    }
  });
});

describe("what the privacy policy is not allowed to say", () => {
  const text = JSON.stringify(privacy);

  it("never claims deletion is immediate everywhere: backups keep it up to 30 days (PRD §12.4)", () => {
    expect(text).not.toMatch(
      /deleted immediately everywhere|gone for good|instantly erased everywhere/i,
    );
    expect(text).toMatch(
      /backups until those backups age out, which takes up to 30 days/,
    );
  });

  it("quotes the no-training term exactly as the verification record has it", () => {
    const record = readFileSync(
      join(process.cwd(), "..", "docs", "legal", "verification.md"),
      "utf8",
    );
    const quote = "Anthropic may not train models on Customer Content from Services.";
    expect(record).toContain(quote);
    expect(text).toContain(quote);
  });

  it("every row of the rights table promises 'immediately' or '72 hours', never longer", () => {
    const section = privacy.sections.find((x) => x.heading === "Your rights");
    if (!section) throw new Error("the privacy policy has no 'Your rights' section");
    const table = /** @type {{ table: { rows: string[][] } }} */ (section.blocks[0])
      .table;
    expect(table.rows.length).toBeGreaterThanOrEqual(5);
    for (const [right, , when] of table.rows) {
      expect(when, right).toMatch(
        /^(Immediately, yourself|Within 72 hours of your request)/,
      );
    }
  });

  it("commits to the strictest clock of the three declared laws: 72 hours", () => {
    expect(text).toMatch(/UU PDP/);
    expect(text).toMatch(/GDPR/);
    expect(text).toMatch(/Within 72 hours of your request/);
    expect(text).toMatch(/within 72 hours of finding out/);
  });
});

describe("the legal footer is on every layout", () => {
  const expected = ["/privacy", "/terms", "/subprocessors", "/.well-known/security.txt"];

  it("on a signed-out screen (AuthShell)", () => {
    renderApp({ path: "/login" });
    expect(legalLinks()).toEqual(expected);
  });

  it("on a signed-in screen (the app chrome)", () => {
    renderApp({ path: "/settings", status: "authenticated" });
    expect(legalLinks()).toEqual(expected);
  });

  it("on the legal pages themselves", () => {
    renderApp({ path: "/terms" });
    expect(legalLinks()).toEqual(expected);
  });

  it("and the upload screen links the privacy policy and terms where the file is handed over", () => {
    renderApp({ path: "/", status: "authenticated" });
    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: "privacy policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(within(main).getByRole("link", { name: "terms of service" })).toHaveAttribute(
      "href",
      "/terms",
    );
    expect(main.textContent).toMatch(/from our backups within 30 days/);
    expect(main.textContent).not.toMatch(/gone for good/);
  });
});
