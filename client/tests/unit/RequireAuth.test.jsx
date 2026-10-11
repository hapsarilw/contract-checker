import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation, useSearchParams } from "react-router";
import { RequireAuth } from "../../src/auth/RequireAuth.jsx";
import { AuthContext } from "../../src/auth/AuthContext.js";

function SearchProbe() {
  return <p>{useLocation().search}</p>;
}

/**
 * @param {{
 *   status: "loading" | "authenticated" | "unauthenticated",
 *   endedBecause?: string,
 *   initialEntries?: string[],
 * }} options
 */
function renderGuarded({ status, endedBecause, initialEntries = ["/documents/abc"] }) {
  const value = {
    status,
    endedBecause,
    user: status === "authenticated" ? { id: "u1", email: "a@b.com" } : null,
    setUser: () => {},
    signOut: () => {},
  };
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthContext.Provider value={value}>
        <Routes>
          <Route
            path="/documents/abc"
            element={
              <RequireAuth>
                <p>Protected content</p>
              </RequireAuth>
            }
          />
          <Route path="/login" element={<p>Login screen</p>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe("RequireAuth (BUILD-PLAN step 32, FR-7.1)", () => {
  it("renders a polite loading indicator while status is loading, not the protected content", () => {
    renderGuarded({ status: "loading" });
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders the protected content when authenticated", () => {
    renderGuarded({ status: "authenticated" });
    expect(screen.getByText("Protected content")).toBeInTheDocument();
  });

  it("redirects to /login when unauthenticated, WITHOUT a session_expired reason", () => {
    renderGuarded({ status: "unauthenticated" });
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("carries the current path (including its query string) as returnTo", () => {
    function CapturingLogin() {
      const [searchParams] = useSearchParams();
      return <p>returnTo={searchParams.get("returnTo")}</p>;
    }
    const value = {
      status: "unauthenticated",
      user: null,
      setUser: () => {},
      signOut: () => {},
    };
    render(
      <MemoryRouter initialEntries={["/documents/abc?tab=findings"]}>
        <AuthContext.Provider value={value}>
          <Routes>
            <Route
              path="/documents/abc"
              element={
                <RequireAuth>
                  <p>Protected content</p>
                </RequireAuth>
              }
            />
            <Route path="/login" element={<CapturingLogin />} />
          </Routes>
        </AuthContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByText("returnTo=/documents/abc?tab=findings")).toBeInTheDocument();
  });

  it("sends a session the app ended on purpose to /login with the reason and NO returnTo", () => {
    render(
      <MemoryRouter initialEntries={["/documents/abc"]}>
        <AuthContext.Provider
          value={{
            status: "unauthenticated",
            endedBecause: "account_deleted",
            user: null,
            setUser: () => {},
            signOut: () => {},
          }}
        >
          <Routes>
            <Route
              path="/documents/abc"
              element={
                <RequireAuth>
                  <p>Protected content</p>
                </RequireAuth>
              }
            />
            <Route path="/login" element={<SearchProbe />} />
          </Routes>
        </AuthContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByText("?reason=account_deleted")).toBeInTheDocument();
  });
});

describe("RequireAuth when the session check could not be answered (step 75)", () => {
  const DB_DOWN =
    "We can't reach your saved contracts and reports for a moment. Nothing has been lost. Try again in a minute.";

  /** @param {{ checking?: boolean }} [options] */
  function renderUnavailable({ checking = false } = {}) {
    const retrySessionCheck = vi.fn().mockResolvedValue(undefined);
    render(
      <MemoryRouter initialEntries={["/documents/abc"]}>
        <AuthContext.Provider
          value={{
            status: "unavailable",
            user: null,
            message: DB_DOWN,
            retryAfter: 30,
            checking,
            setUser: () => {},
            signOut: () => {},
            retrySessionCheck,
          }}
        >
          <Routes>
            <Route
              path="/documents/abc"
              element={
                <RequireAuth>
                  <p>Protected content</p>
                </RequireAuth>
              }
            />
            <Route path="/login" element={<p>Login screen</p>} />
          </Routes>
        </AuthContext.Provider>
      </MemoryRouter>,
    );
    return { retrySessionCheck };
  }

  it("stays put and says so: no redirect to /login, no protected content", () => {
    renderUnavailable();
    expect(screen.queryByText("Login screen")).not.toBeInTheDocument();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: /can’t be reached/ }),
    ).toBeInTheDocument();
  });

  it("announces the server's own message, which says nothing was lost", () => {
    renderUnavailable();
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing has been lost");
  });

  it("tells a possibly signed-in person they are not signed out, and when it tries again", () => {
    renderUnavailable();
    expect(screen.getByText(/nothing here signed you out/)).toBeInTheDocument();
    expect(screen.getByText(/every 30 seconds/)).toBeInTheDocument();
  });

  it("'Try again now' runs the check", async () => {
    const { retrySessionCheck } = renderUnavailable();
    await userEvent.click(screen.getByRole("button", { name: "Try again now" }));
    expect(retrySessionCheck).toHaveBeenCalledTimes(1);
  });

  it("while a check runs, the button stays focusable (aria-disabled, not disabled) and does nothing", async () => {
    const { retrySessionCheck } = renderUnavailable({ checking: true });
    const button = screen.getByRole("button", { name: "Trying again…" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(retrySessionCheck).not.toHaveBeenCalled();
  });
});
