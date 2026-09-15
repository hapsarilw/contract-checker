import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import AppHeader from "../../src/components/AppHeader.jsx";
import { AuthContext } from "../../src/auth/AuthContext.js";
import { I18nProvider } from "../../src/i18n/index.js";

/** @param {{ path: string, signOut?: () => void }} options */
function renderHeader({ path, signOut = vi.fn() }) {
  const value = {
    status: "authenticated",
    user: { id: "u1", email: "a@b.com", accountState: "ACTIVE" },
    setUser: () => {},
    signOut,
  };
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[path]}>
        <AuthContext.Provider value={value}>
          <AppHeader />
        </AuthContext.Provider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("AppHeader (BUILD-PLAN step 39)", () => {
  it("renders the brand name and the prototype's three nav items", () => {
    renderHeader({ path: "/" });
    expect(screen.getByText("ClauseCheck")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New contract" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "History" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("marks 'New contract' current on /, and 'History' on neither / nor /documents", () => {
    renderHeader({ path: "/" });
    expect(screen.getByRole("link", { name: "New contract" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "History" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("marks 'History' current on /documents", () => {
    renderHeader({ path: "/documents" });
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks 'History' current on /documents/:id too — opening a report is still the history flow", () => {
    renderHeader({ path: "/documents/doc1" });
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("'Sign out' is a real button (an action, not a navigation) and calls signOut", () => {
    const signOut = vi.fn();
    renderHeader({ path: "/", signOut });

    const button = screen.getByRole("button", { name: "Sign out" });
    expect(button.tagName).toBe("BUTTON");
    fireEvent.click(button);

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("has no axe violations", async () => {
    const { axe } = await import("jest-axe");
    const { container } = renderHeader({ path: "/" });
    expect(await axe(container)).toHaveNoViolations();
  });
});
