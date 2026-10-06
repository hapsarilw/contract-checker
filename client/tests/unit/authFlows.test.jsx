import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { AuthContext } from "../../src/auth/AuthContext.js";
import { ApiError } from "../../src/api/client.js";
import VerifyEmailPage from "../../src/pages/VerifyEmailPage.jsx";
import ForgotPasswordPage from "../../src/pages/ForgotPasswordPage.jsx";
import ResetPasswordPage from "../../src/pages/ResetPasswordPage.jsx";
import VerifyEmailBanner from "../../src/components/VerifyEmailBanner.jsx";
import ConfirmEmailChangePage from "../../src/pages/ConfirmEmailChangePage.jsx";
import AuthForm from "../../src/pages/AuthForm.jsx";

vi.mock("../../src/api/client.js", async (importOriginal) => {
  const actual = /** @type {object} */ (await importOriginal());
  return { ...actual, apiFetch: vi.fn() };
});
const { apiFetch } = await import("../../src/api/client.js");

const ACTIVE = { id: "u1", email: "a@b.com", state: "ACTIVE" };
const UNVERIFIED = { id: "u1", email: "a@b.com", state: "UNVERIFIED" };

/**
 * @param {import("react").ReactNode} ui
 * @param {{ path: string, user?: object | null, strict?: boolean }} options
 */
function renderAt(ui, { path, user = null, strict = false }) {
  const refreshUser = vi.fn();
  const value = {
    status: user ? "authenticated" : "unauthenticated",
    user,
    setUser: vi.fn(),
    signOut: vi.fn(),
    clearSession: vi.fn(),
    refreshUser,
  };
  const tree = (
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { refreshUser };
}

const apiError = (code, message, status = 400) =>
  new ApiError(code, message, "req", status);
const calls = (path) => vi.mocked(apiFetch).mock.calls.filter(([p]) => p === path);

afterEach(() => vi.clearAllMocks());

describe("VerifyEmailPage (FR-1.7)", () => {
  it("submits the token exactly ONCE even under StrictMode's double-invoked effects, and shows success", async () => {
    // The token is single-use: a second POST would fail with "already
    // used" and turn a success into a failure screen.
    vi.mocked(apiFetch).mockResolvedValue({ verified: true });
    const { refreshUser } = renderAt(<VerifyEmailPage />, {
      path: "/verify-email?token=strict-once",
      strict: true,
    });

    expect(
      await screen.findByRole("heading", { level: 1, name: "Email verified" }),
    ).toBeVisible();
    expect(calls("/api/v1/auth/verify-email")).toHaveLength(1);
    expect(calls("/api/v1/auth/verify-email")[0][1]).toEqual({
      method: "POST",
      body: { token: "strict-once" },
    });
    // The banner must not outlive the verification.
    expect(refreshUser).toHaveBeenCalled();
  });

  it("names all three causes for a spent link, without claiming to know which", async () => {
    vi.mocked(apiFetch).mockRejectedValue(apiError("VALIDATION_ERROR", "unusable"));
    renderAt(<VerifyEmailPage />, { path: "/verify-email?token=spent" });

    expect(
      await screen.findByRole("heading", { level: 1, name: "This link can't be used" }),
    ).toBeVisible();
    expect(
      screen.getByText(/invalid, it has already been used, or it has expired/),
    ).toBeVisible();
    // Signed out: the way forward is to sign in, where a new link can be sent.
    expect(screen.getByRole("link", { name: /sign in/i })).toBeVisible();
  });

  it("a spent link is NOT a failure for someone signed in and already verified", async () => {
    vi.mocked(apiFetch).mockRejectedValue(apiError("VALIDATION_ERROR", "unusable"));
    renderAt(<VerifyEmailPage />, { path: "/verify-email?token=spent-2", user: ACTIVE });

    expect(
      await screen.findByRole("heading", { level: 1, name: "You're already verified" }),
    ).toBeVisible();
  });

  it("offers a fresh link, in place, to someone signed in and still unverified", async () => {
    vi.mocked(apiFetch).mockRejectedValue(apiError("VALIDATION_ERROR", "unusable"));
    renderAt(<VerifyEmailPage />, {
      path: "/verify-email?token=spent-3",
      user: UNVERIFIED,
    });

    expect(
      await screen.findByRole("button", { name: "Send the link again" }),
    ).toBeVisible();
  });

  it("a link with no token makes no request and says the link is incomplete", () => {
    renderAt(<VerifyEmailPage />, { path: "/verify-email" });

    expect(
      screen.getByRole("heading", { level: 1, name: "This link is incomplete" }),
    ).toBeVisible();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("a network failure is retryable, and 'Try again' makes a NEW request rather than replaying the failure", async () => {
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(apiError("NETWORK_ERROR", "offline", 0))
      .mockResolvedValueOnce({ verified: true });
    renderAt(<VerifyEmailPage />, { path: "/verify-email?token=flaky" });

    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Email verified" }),
    ).toBeVisible();
    expect(calls("/api/v1/auth/verify-email")).toHaveLength(2);
  });
});

describe("VerifyEmailBanner (FR-1.7)", () => {
  it("shows for an UNVERIFIED account, naming the address", () => {
    renderAt(<VerifyEmailBanner />, { path: "/", user: UNVERIFIED });
    expect(screen.getByText("Verify your email to run a check")).toBeVisible();
    expect(screen.getByText("a@b.com")).toBeVisible();
  });

  it.each([
    ["an ACTIVE account", ACTIVE],
    ["a signed-out visitor", null],
  ])("renders nothing for %s", (_label, user) => {
    renderAt(<VerifyEmailBanner />, { path: "/", user });
    expect(
      screen.queryByText("Verify your email to run a check"),
    ).not.toBeInTheDocument();
  });

  it("'already verified' from the server refreshes the session so the banner can go", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ sent: false, alreadyVerified: true });
    const { refreshUser } = renderAt(<VerifyEmailBanner />, {
      path: "/",
      user: UNVERIFIED,
    });

    fireEvent.click(screen.getByRole("button", { name: "Send the link again" }));

    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
  });

  it("shows the server's own rate-limit message rather than a generic one", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      apiError("RATE_LIMITED", "You can request 3 links an hour. Try again later.", 429),
    );
    renderAt(<VerifyEmailBanner />, { path: "/", user: UNVERIFIED });

    fireEvent.click(screen.getByRole("button", { name: "Send the link again" }));

    expect(await screen.findByText(/3 links an hour/)).toBeVisible();
  });
});

describe("ConfirmEmailChangePage (FR-1.13, step 75)", () => {
  it("spends the token exactly ONCE under StrictMode, names the new address, and refreshes the session", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ changed: true, email: "new@b.com" });
    const { refreshUser } = renderAt(<ConfirmEmailChangePage />, {
      path: "/confirm-email-change?token=strict-once",
      user: { ...UNVERIFIED, pendingEmail: "new@b.com" },
      strict: true,
    });

    expect(
      await screen.findByRole("heading", { level: 1, name: "Email changed" }),
    ).toBeVisible();
    expect(screen.getByText(/Your address is now new@b.com/)).toBeVisible();
    expect(calls("/api/v1/auth/confirm-email-change")).toHaveLength(1);
    expect(calls("/api/v1/auth/confirm-email-change")[0][1]).toEqual({
      method: "POST",
      body: { token: "strict-once" },
    });
    expect(refreshUser).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Back to settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("works signed out too, pointing at sign-in", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ changed: true, email: "new@b.com" });
    renderAt(<ConfirmEmailChangePage />, {
      path: "/confirm-email-change?token=signed-out",
    });
    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it("says a spent or replaced link left the address unchanged, and where to get a new one", async () => {
    vi.mocked(apiFetch).mockRejectedValue(apiError("VALIDATION_ERROR", "unusable"));
    renderAt(<ConfirmEmailChangePage />, { path: "/confirm-email-change?token=spent" });
    expect(
      await screen.findByRole("heading", { level: 1, name: "This link can't be used" }),
    ).toBeVisible();
    expect(screen.getByText(/Your address has not changed/)).toBeVisible();
    expect(screen.getByText(/a newer change replaced it/)).toBeVisible();
  });

  it("a link with no token makes no request", () => {
    renderAt(<ConfirmEmailChangePage />, { path: "/confirm-email-change" });
    expect(
      screen.getByRole("heading", { level: 1, name: "This link is incomplete" }),
    ).toBeVisible();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("a failure that did not spend the link offers Try again, which makes a NEW request", async () => {
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(
        apiError("NETWORK_ERROR", "We couldn’t reach the server.", 0),
      )
      .mockResolvedValueOnce({ changed: true, email: "new@b.com" });
    renderAt(<ConfirmEmailChangePage />, { path: "/confirm-email-change?token=retry" });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Email changed" }),
    ).toBeVisible();
    expect(calls("/api/v1/auth/confirm-email-change")).toHaveLength(2);
  });
});

describe("VerifyEmailBanner while an email change is pending (FR-1.13, step 75)", () => {
  it("names the NEW mailbox, says checks are paused, and offers no resend to the old address", () => {
    renderAt(<VerifyEmailBanner />, {
      path: "/",
      user: { ...UNVERIFIED, pendingEmail: "new@b.com" },
    });
    expect(screen.getByText("Confirm your new email to run a check")).toBeVisible();
    expect(screen.getByText("new@b.com")).toBeVisible();
    expect(screen.getByText(/checks are paused/)).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Start the change again in Settings/ }),
    ).toHaveAttribute("href", "/settings");
    // The signup variant's resend would mail the OLD address.
    expect(screen.queryByRole("button", { name: /resend|send.*link/i })).toBeNull();
    expect(screen.queryByText(/when you signed up/)).toBeNull();
  });
});

describe("ForgotPasswordPage (FR-1.8)", () => {
  it("makes no request for an obviously malformed address", () => {
    renderAt(<ForgotPasswordPage />, { path: "/forgot-password" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(screen.getByText(/valid email address/)).toBeVisible();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("shows one confirmation that does not reveal whether the account exists", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ accepted: true });
    renderAt(<ForgotPasswordPage />, { path: "/forgot-password" });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "  who@x.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Check your inbox" }),
    ).toBeVisible();
    expect(screen.getByText(/If that address has an account/)).toBeVisible();
    expect(calls("/api/v1/auth/forgot-password")[0][1]).toEqual({
      method: "POST",
      body: { email: "who@x.com" },
    });
  });

  it("shows a server failure (e.g. the rate limit) as an error, not as the confirmation", async () => {
    vi.mocked(apiFetch).mockRejectedValue(apiError("RATE_LIMITED", "Slow down.", 429));
    renderAt(<ForgotPasswordPage />, { path: "/forgot-password" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "who@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText("Slow down.")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Check your inbox" }),
    ).not.toBeInTheDocument();
  });
});

describe("ResetPasswordPage (FR-1.8 / FR-1.9)", () => {
  const fillAndSubmit = (password) => {
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: password },
    });
    fireEvent.click(screen.getByRole("button", { name: /change|save|set/i }));
  };

  it("sends the token from the link with the new password, then confirms and points at sign-in", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ reset: true });
    renderAt(<ResetPasswordPage />, { path: "/reset-password?token=t0k" });

    fillAndSubmit("a-long-enough-one");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Password changed" }),
    ).toBeVisible();
    expect(calls("/api/v1/auth/reset-password")[0][1]).toEqual({
      method: "POST",
      body: { token: "t0k", password: "a-long-enough-one" },
    });
    expect(screen.getByRole("link", { name: "Sign in" })).toBeVisible();
  });

  it("rejects a too-short password before any request, and states the rule up front", () => {
    renderAt(<ResetPasswordPage />, { path: "/reset-password?token=t0k" });
    expect(screen.getByText(/At least 10 characters/)).toBeVisible();

    fillAndSubmit("short");

    expect(screen.getByText("Use at least 10 characters.")).toBeVisible();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("shows the server's message for a link that can't be used and offers a new one", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      apiError("VALIDATION_ERROR", "This link can’t be used."),
    );
    renderAt(<ResetPasswordPage />, { path: "/reset-password?token=old" });

    fillAndSubmit("a-long-enough-one");

    expect(await screen.findByText("This link can’t be used.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Request a new one" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("a link with no token makes no request", () => {
    renderAt(<ResetPasswordPage />, { path: "/reset-password" });
    expect(
      screen.getByRole("heading", { level: 1, name: "This link is incomplete" }),
    ).toBeVisible();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("AuthForm sign-in additions", () => {
  it("links to the password reset from sign-in only, not from registration", () => {
    const { unmount } = render(
      <AuthContext.Provider
        value={{
          status: "unauthenticated",
          user: null,
          setUser: vi.fn(),
          signOut: vi.fn(),
          clearSession: vi.fn(),
          refreshUser: vi.fn(),
        }}
      >
        <MemoryRouter>
          <AuthForm mode="signin" />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    unmount();
    render(
      <AuthContext.Provider
        value={{
          status: "unauthenticated",
          user: null,
          setUser: vi.fn(),
          signOut: vi.fn(),
          clearSession: vi.fn(),
          refreshUser: vi.fn(),
        }}
      >
        <MemoryRouter>
          <AuthForm mode="register" />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(
      screen.queryByRole("link", { name: "Forgot your password?" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["signed_out_everywhere", "You were signed out everywhere"],
    ["account_deleted", "Your account was deleted"],
    ["session_expired", "You were signed out"],
  ])("explains ?reason=%s", (reason, title) => {
    render(
      <AuthContext.Provider
        value={{
          status: "unauthenticated",
          user: null,
          setUser: vi.fn(),
          signOut: vi.fn(),
          clearSession: vi.fn(),
          refreshUser: vi.fn(),
        }}
      >
        <MemoryRouter initialEntries={[`/login?reason=${reason}`]}>
          <AuthForm mode="signin" />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.getByText(title)).toBeVisible();
  });

  it("an unknown ?reason= says nothing", () => {
    render(
      <AuthContext.Provider
        value={{
          status: "unauthenticated",
          user: null,
          setUser: vi.fn(),
          signOut: vi.fn(),
          clearSession: vi.fn(),
          refreshUser: vi.fn(),
        }}
      >
        <MemoryRouter initialEntries={["/login?reason=you_won_a_prize"]}>
          <AuthForm mode="signin" />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.queryByText(/prize/i)).not.toBeInTheDocument();
  });
});
