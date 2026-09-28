import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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
