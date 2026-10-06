import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { AuthContext } from "../../src/auth/AuthContext.js";
import { ApiError } from "../../src/api/client.js";
import { RequireAuth } from "../../src/auth/RequireAuth.jsx";
import SettingsPage from "../../src/pages/SettingsPage.jsx";

vi.mock("../../src/api/client.js", async (importOriginal) => {
  const actual = /** @type {object} */ (await importOriginal());
  return { ...actual, apiFetch: vi.fn() };
});
const { apiFetch } = await import("../../src/api/client.js");

const apiError = (code, message, status = 400) =>
  new ApiError(code, message, "req", status);
const calls = (path, method) =>
  vi
    .mocked(apiFetch)
    .mock.calls.filter(([p, o]) => p === path && (o?.method ?? "GET") === method);

/**
 * A STATEFUL auth context inside the real RequireAuth, on purpose. With a
 * static context the settings screen is never redirected when the session
 * is cleared, which hid a real bug: clearing the session flips RequireAuth
 * to "send them to /login?returnTo=/settings", and that redirect raced the
 * screen's own navigation to /login?reason=... and won.
 */
function StatefulAuth({ clearSession, children }) {
  const [status, setStatus] = useState("authenticated");
  const [endedBecause, setEndedBecause] = useState(undefined);
  const value = {
    status,
    endedBecause,
    user:
      status === "authenticated"
        ? { id: "u1", email: "me@x.com", state: "ACTIVE" }
        : null,
    setUser: vi.fn(),
    signOut: vi.fn(),
    clearSession: (reason) => {
      clearSession(reason);
      setEndedBecause(reason);
      setStatus("unauthenticated");
    },
    refreshUser: vi.fn(),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function renderSettings() {
  const clearSession = vi.fn();
  render(
    <StatefulAuth clearSession={clearSession}>
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <SettingsPage />
              </RequireAuth>
            }
          />
          <Route path="/login" element={<LoginProbe />} />
        </Routes>
      </MemoryRouter>
    </StatefulAuth>,
  );
  return { clearSession };
}

function LoginProbe() {
  const { search } = useLocation();
  return <p>{`login screen ${search}`}</p>;
}

afterEach(() => vi.clearAllMocks());

describe("SettingsPage (FR-7.1, FR-1.9, FR-4.5, FR-4.6)", () => {
  it("has one h1 and one labelled h2 per section, the destructive one last", () => {
    renderSettings();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual([
      "Change your password",
      "Change your email",
      "Sign out everywhere",
      "Download your data",
      "Delete your account",
    ]);
    expect(screen.getByText("me@x.com")).toBeVisible();
  });

  describe("change password", () => {
    // Two forms on the page ask for the current password now (step 75), so
    // each is reached through its own labelled region, as a screen-reader
    // user would.
    const section = () =>
      within(screen.getByRole("region", { name: "Change your password" }));
    const submit = (current, next) => {
      fireEvent.change(section().getByLabelText("Current password"), {
        target: { value: current },
      });
      fireEvent.change(section().getByLabelText("New password"), {
        target: { value: next },
      });
      fireEvent.click(section().getByRole("button", { name: "Change password" }));
    };

    it("sends both passwords, clears the fields, and says other devices were signed out", async () => {
      vi.mocked(apiFetch).mockResolvedValue({ changed: true });
      renderSettings();

      submit("old-password-1", "brand-new-password");

      expect(await screen.findByText(/Your other devices were signed out/)).toBeVisible();
      expect(calls("/api/v1/auth/change-password", "POST")[0][1]?.body).toEqual({
        currentPassword: "old-password-1",
        newPassword: "brand-new-password",
      });
      expect(section().getByLabelText("Current password")).toHaveValue("");
      expect(section().getByLabelText("New password")).toHaveValue("");
    });

    it("validates locally with no request: an empty current and a short new password", () => {
      renderSettings();
      submit("", "short");
      expect(screen.getByText("Enter your current password.")).toBeVisible();
      expect(screen.getByText("Use at least 10 characters.")).toBeVisible();
      expect(apiFetch).not.toHaveBeenCalled();
    });

    it("puts a wrong-current-password answer on the current-password field", async () => {
      vi.mocked(apiFetch).mockRejectedValue(
        apiError("VALIDATION_ERROR", "That is not your current password."),
      );
      renderSettings();

      submit("wrong-password", "brand-new-password");

      const field = section().getByLabelText("Current password");
      expect(await screen.findByText("That is not your current password.")).toBeVisible();
      expect(field).toHaveAttribute("aria-invalid", "true");
    });
  });

  describe("change email (FR-1.13, step 75)", () => {
    const section = () =>
      within(screen.getByRole("region", { name: "Change your email" }));
    const submit = (email, password) => {
      fireEvent.change(section().getByLabelText("New email address"), {
        target: { value: email },
      });
      fireEvent.change(section().getByLabelText("Current password"), {
        target: { value: password },
      });
      fireEvent.click(section().getByRole("button", { name: "Send confirmation link" }));
    };

    it("says up front that checks pause until the new address is confirmed", () => {
      renderSettings();
      expect(section().getByText(/new checks are paused/)).toBeVisible();
      expect(section().getByText(/We also tell your current address/)).toBeVisible();
    });

    it("sends the trimmed address and the password, clears the form, and names the mailbox to check", async () => {
      vi.mocked(apiFetch).mockResolvedValue({ pending: true });
      renderSettings();

      submit("  new@x.com ", "my-password-1");

      expect(
        await section().findByText(/Check new@x.com for the confirmation link/),
      ).toBeVisible();
      expect(calls("/api/v1/auth/change-email", "POST")[0][1]?.body).toEqual({
        email: "new@x.com",
        currentPassword: "my-password-1",
      });
      expect(section().getByLabelText("New email address")).toHaveValue("");
      expect(section().getByLabelText("Current password")).toHaveValue("");
    });

    it("validates locally with no request: not an address, no password", () => {
      renderSettings();
      submit("not-an-address", "");
      expect(section().getByText(/Enter the new email address/)).toBeVisible();
      expect(section().getByText("Enter your current password.")).toBeVisible();
      expect(apiFetch).not.toHaveBeenCalled();
    });

    it("puts EMAIL_TAKEN on the address field, and a wrong password on the password field", async () => {
      vi.mocked(apiFetch).mockRejectedValueOnce(
        apiError("EMAIL_TAKEN", "An account with that email already exists.", 409),
      );
      renderSettings();
      submit("taken@x.com", "my-password-1");
      expect(
        await section().findByText("An account with that email already exists."),
      ).toBeVisible();
      expect(section().getByLabelText("New email address")).toHaveAttribute(
        "aria-invalid",
        "true",
      );

      vi.mocked(apiFetch).mockRejectedValueOnce(
        apiError("VALIDATION_ERROR", "That is not your current password."),
      );
      submit("free@x.com", "wrong-password");
      expect(
        await section().findByText("That is not your current password."),
      ).toBeVisible();
      expect(section().getByLabelText("Current password")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });
  });

  describe("sign out everywhere", () => {
    it("ends the session, forgets it locally WITHOUT a further request, and lands on /login with the reason", async () => {
      vi.mocked(apiFetch).mockResolvedValue({ loggedOut: true });
      const { clearSession } = renderSettings();

      fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));

      expect(
        await screen.findByText("login screen ?reason=signed_out_everywhere"),
      ).toBeVisible();
      expect(clearSession).toHaveBeenCalledWith("signed_out_everywhere");
      // The whole point of clearSession over signOut: no second call to
      // the API with a cookie the first one just revoked.
      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(calls("/api/v1/auth/logout-all", "POST")).toHaveLength(1);
    });

    it("stays put and says so when the request fails", async () => {
      vi.mocked(apiFetch).mockRejectedValue(apiError("INTERNAL", "Try later.", 500));
      const { clearSession } = renderSettings();

      fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));

      expect(await screen.findByText("Try later.")).toBeVisible();
      expect(clearSession).not.toHaveBeenCalled();
      expect(screen.queryByText(/login screen/)).not.toBeInTheDocument();
    });
  });

  describe("download my data", () => {
    it("fetches the export and saves it as a dated JSON file", async () => {
      vi.mocked(apiFetch).mockResolvedValue({ user: { id: "u1" }, documents: [] });
      const create = vi.fn(() => "blob:fake");
      const revoke = vi.fn();
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
      const clicked = [];
      const realClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        clicked.push({ href: this.href, download: this.download });
      };
      try {
        renderSettings();
        fireEvent.click(screen.getByRole("button", { name: "Download my data" }));

        await waitFor(() => expect(clicked).toHaveLength(1));
        expect(clicked[0].download).toMatch(
          /^clausecheck-export-\d{4}-\d{2}-\d{2}\.json$/,
        );
        expect(revoke).toHaveBeenCalledWith("blob:fake");
        expect(calls("/api/v1/account/export", "GET")).toHaveLength(1);
        expect(await screen.findByText(/Downloaded clausecheck-export-/)).toBeVisible();
      } finally {
        HTMLAnchorElement.prototype.click = realClick;
      }
    });

    it("shows the server's message when the daily limit is reached, and downloads nothing", async () => {
      vi.mocked(apiFetch).mockRejectedValue(
        apiError("RATE_LIMITED", "You can export 3 times a day.", 429),
      );
      const create = vi.fn();
      Object.assign(URL, { createObjectURL: create });
      renderSettings();

      fireEvent.click(screen.getByRole("button", { name: "Download my data" }));

      expect(await screen.findByText("You can export 3 times a day.")).toBeVisible();
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe("delete my account", () => {
    const openDialog = () =>
      fireEvent.click(screen.getByRole("button", { name: "Delete my account…" }));

    it("states exactly what is destroyed, and what is not instantly gone, before asking for anything", () => {
      renderSettings();
      openDialog();

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent(
        /every contract you uploaded, including its full text/,
      );
      expect(dialog).toHaveTextContent(/every report and every finding/);
      expect(dialog).toHaveTextContent(/Backups keep a copy for up to 30 days/);
      expect(dialog).toHaveTextContent(/can’t be undone/);
    });

    it("sends nothing on open, and nothing when the password is empty", () => {
      renderSettings();
      openDialog();
      expect(apiFetch).not.toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole("button", { name: "Delete everything permanently" }),
      );

      expect(screen.getByText("Enter your password to confirm.")).toBeVisible();
      expect(apiFetch).not.toHaveBeenCalled();
    });

    it("'Keep my account' closes it without a request", () => {
      renderSettings();
      openDialog();
      fireEvent.click(screen.getByRole("button", { name: "Keep my account" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(apiFetch).not.toHaveBeenCalled();
    });

    it("deletes with the password, forgets the session locally, and lands on /login with the reason", async () => {
      vi.mocked(apiFetch).mockResolvedValue(undefined);
      const { clearSession } = renderSettings();
      openDialog();

      fireEvent.change(screen.getByLabelText("Enter your password to confirm"), {
        target: { value: "my-password-123" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Delete everything permanently" }),
      );

      expect(
        await screen.findByText("login screen ?reason=account_deleted"),
      ).toBeVisible();
      expect(calls("/api/v1/account", "DELETE")[0][1]?.body).toEqual({
        password: "my-password-123",
      });
      expect(clearSession).toHaveBeenCalledWith("account_deleted");
      expect(apiFetch).toHaveBeenCalledTimes(1);
    });

    it("keeps the dialog open and shows a wrong password on the password field, not a banner", async () => {
      vi.mocked(apiFetch).mockRejectedValue(
        apiError("VALIDATION_ERROR", "That password is not correct."),
      );
      const { clearSession } = renderSettings();
      openDialog();

      fireEvent.change(screen.getByLabelText("Enter your password to confirm"), {
        target: { value: "nope-nope-nope" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Delete everything permanently" }),
      );

      expect(await screen.findByText("That password is not correct.")).toBeVisible();
      expect(screen.getByLabelText("Enter your password to confirm")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(clearSession).not.toHaveBeenCalled();
    });
  });
});
