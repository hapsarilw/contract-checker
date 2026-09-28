import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import App from "../../src/App.jsx";
import { AuthContext } from "../../src/auth/AuthContext.js";
import { I18nProvider } from "../../src/i18n/index.js";

vi.mock("../../src/api/client.js", async (importOriginal) => {
  const actual = /** @type {object} */ (await importOriginal());
  return { ...actual, apiFetch: vi.fn(() => new Promise(() => {})) }; // never resolves — no page under test needs it to
});

vi.mock("../../src/pages/UploadPage.jsx", () => ({
  default: () => {
    throw new Error("boom — a render bug on the upload screen");
  },
}));

/** @param {{ path: string, status?: "loading" | "authenticated" | "unauthenticated" }} options */
function renderApp({ path, status = "authenticated" }) {
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

describe("App (BUILD-PLAN step 39, FR-7.1)", () => {
  it("wraps a route in an ErrorBoundary — a render error shows the recoverable fallback, not a crash", () => {
    renderApp({ path: "/" });
    expect(
      screen.getByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/hit an unexpected error/)).toBeInTheDocument();
  });

  it("shows the app chrome around a protected route", () => {
    renderApp({ path: "/documents" });
    expect(screen.getByText("ClauseCheck")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New contract" })).toBeInTheDocument();
  });

  it("shows no app chrome on /login", () => {
    renderApp({ path: "/login", status: "unauthenticated" });
    // Not a "ClauseCheck" text check — AuthForm has its own brand mark
    // on this screen, unrelated to AppHeader; `banner` (the <header>
    // landmark's implicit role) and the nav link are what's actually
    // AppHeader-specific.
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New contract" })).not.toBeInTheDocument();
  });

  it("shows no app chrome on the auth-flow screens (verify-email, forgot-password, reset-password)", () => {
    for (const path of ["/verify-email", "/forgot-password", "/reset-password"]) {
      const { unmount } = renderApp({ path, status: "unauthenticated" });
      expect(screen.queryByRole("banner")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("the three auth-flow screens render without requiring authentication", () => {
    for (const [path, title] of /** @type {const} */ ([
      ["/verify-email", "This link is incomplete"],
      ["/forgot-password", "Forgot your password?"],
      ["/reset-password", "This link is incomplete"],
    ])) {
      const { unmount } = renderApp({ path, status: "unauthenticated" });
      expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
      unmount();
    }
  });

  it("/settings is protected — an unauthenticated visitor is redirected to /login", () => {
    renderApp({ path: "/settings", status: "unauthenticated" });
    expect(
      screen.getByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeInTheDocument();
  });

  it("/settings renders the settings screen, with chrome, once authenticated", () => {
    renderApp({ path: "/settings" });
    expect(
      screen.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ClauseCheck")).toBeInTheDocument();
  });

  it("an unmatched path renders the 404 page", () => {
    renderApp({ path: "/this-page-does-not-exist" });
    expect(screen.getByText("There’s nothing at this address.")).toBeInTheDocument();
  });

  it("every other protected route also redirects when unauthenticated (FR-7.1)", () => {
    for (const path of ["/", "/documents", "/documents/abc", "/settings"]) {
      const { unmount } = renderApp({ path, status: "unauthenticated" });
      expect(
        screen.getByRole("heading", { level: 1, name: "Sign in" }),
      ).toBeInTheDocument();
      unmount();
    }
  });
});
