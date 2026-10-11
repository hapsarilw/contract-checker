import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  AuthProvider,
  DEFAULT_RECHECK_SECONDS,
  MAX_RECHECK_SECONDS,
} from "../../src/auth/AuthProvider.jsx";
import { useAuth } from "../../src/auth/useAuth.js";

vi.mock("../../src/api/client.js", () => ({ apiFetch: vi.fn() }));
const { apiFetch } = await import("../../src/api/client.js");

function Probe() {
  const { status, user } = useAuth();
  return <p>{`${status}:${user?.email ?? "none"}`}</p>;
}

/**
 * What api/client.js throws: an ApiError carries the HTTP status (0 for a
 * network failure), the server's message and its Retry-After. The mock
 * replaces client.js, so this builds the same shape.
 *
 * @param {number} status
 * @param {string} [message]
 * @param {number} [retryAfter]
 */
function apiError(status, message = "failed", retryAfter = undefined) {
  return Object.assign(new Error(message), { status, retryAfter });
}

describe("AuthProvider (BUILD-PLAN step 32, FR-7.7)", () => {
  afterEach(() => vi.clearAllMocks());

  it("starts loading, then authenticated when /me succeeds", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      user: { id: "u1", email: "a@b.com", state: "ACTIVE" },
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByText("loading:none")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("authenticated:a@b.com")).toBeInTheDocument(),
    );
  });

  it("starts loading, then unauthenticated when /me rejects (the ordinary not-signed-in case)", async () => {
    vi.mocked(apiFetch).mockRejectedValue(apiError(401, "Sign in to continue."));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText("unauthenticated:none")).toBeInTheDocument(),
    );
  });

  it("checks /me with suppressAuthRedirect: true — a regression test for the /login-loads-itself bug", async () => {
    // Without this, a 401 from this very check would trigger
    // api/client.js's own redirect-to-login — including while the
    // visitor is already ON /login for the first time, with a spurious
    // "your session expired" banner. See client.js's comment on this
    // flag for the full story.
    vi.mocked(apiFetch).mockResolvedValue({ user: { id: "u1", email: "a@b.com" } });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/v1/auth/me",
      expect.objectContaining({ suppressAuthRedirect: true }),
    );
  });

  it("clears to unauthenticated on a clausecheck:session-expired event", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      user: { id: "u1", email: "a@b.com", state: "ACTIVE" },
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText("authenticated:a@b.com")).toBeInTheDocument(),
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("clausecheck:session-expired"));
    });

    expect(screen.getByText("unauthenticated:none")).toBeInTheDocument();
  });

  it("setUser (called after a successful login/register) makes the provider authenticated immediately, with no second /me round trip", async () => {
    vi.mocked(apiFetch).mockRejectedValue(apiError(401, "Sign in to continue."));

    function LoginSimulator() {
      const auth = useAuth();
      return (
        <button
          type="button"
          onClick={() =>
            auth.setUser({ id: "u2", email: "new@b.com", state: "UNVERIFIED" })
          }
        >
          simulate login
        </button>
      );
    }

    render(
      <AuthProvider>
        <Probe />
        <LoginSimulator />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText("unauthenticated:none")).toBeInTheDocument(),
    );

    const callsBeforeClick = vi.mocked(apiFetch).mock.calls.length;
    act(() => screen.getByRole("button", { name: "simulate login" }).click());

    expect(screen.getByText("authenticated:new@b.com")).toBeInTheDocument();
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(callsBeforeClick);
  });

  describe("a check the server could not answer (step 75)", () => {
    function UnavailableProbe() {
      const auth = useAuth();
      if (auth.status !== "unavailable")
        return <p>{`${auth.status}:${auth.user?.email ?? "none"}`}</p>;
      return (
        <>
          <p>{`unavailable:${auth.retryAfter}:${auth.checking}`}</p>
          <p>{auth.message}</p>
          <button type="button" onClick={() => auth.retrySessionCheck()}>
            retry
          </button>
          <button
            type="button"
            onClick={() =>
              auth.setUser({ id: "u2", email: "new@b.com", state: "ACTIVE" })
            }
          >
            simulate login
          </button>
        </>
      );
    }

    const DB_DOWN =
      "We can't reach your saved contracts and reports for a moment. Nothing has been lost. Try again in a minute.";

    afterEach(() => vi.useRealTimers());

    it("a 503 is not 'signed out': the state is unavailable, with the server's message and wait", async () => {
      vi.mocked(apiFetch).mockRejectedValue(apiError(503, DB_DOWN, 30));
      render(
        <AuthProvider>
          <UnavailableProbe />
        </AuthProvider>,
      );
      await waitFor(() =>
        expect(screen.getByText("unavailable:30:false")).toBeInTheDocument(),
      );
      expect(screen.getByText(DB_DOWN)).toBeInTheDocument();
    });

    it("a network failure (status 0) is unavailable too, with client.js's message and the default wait", async () => {
      vi.mocked(apiFetch).mockRejectedValue(
        apiError(0, "Couldn't reach the server. Check your connection and try again."),
      );
      render(
        <AuthProvider>
          <UnavailableProbe />
        </AuthProvider>,
      );
      await waitFor(() =>
        expect(
          screen.getByText(`unavailable:${DEFAULT_RECHECK_SECONDS}:false`),
        ).toBeInTheDocument(),
      );
      expect(screen.getByText(/Check your connection/)).toBeInTheDocument();
    });

    it("an error that is not an ApiError gets a plain message, never an internal one", async () => {
      vi.mocked(apiFetch).mockRejectedValue(new TypeError("x is undefined"));
      render(
        <AuthProvider>
          <UnavailableProbe />
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByText(/unavailable:/)).toBeInTheDocument());
      expect(screen.queryByText(/x is undefined/)).not.toBeInTheDocument();
      expect(screen.getByText(/couldn't reach ClauseCheck/)).toBeInTheDocument();
    });

    it("caps a long Retry-After, so a rate limit's 15 minutes does not hold the screen that long", async () => {
      vi.mocked(apiFetch).mockRejectedValue(apiError(429, "Too many requests.", 900));
      render(
        <AuthProvider>
          <UnavailableProbe />
        </AuthProvider>,
      );
      await waitFor(() =>
        expect(
          screen.getByText(`unavailable:${MAX_RECHECK_SECONDS}:false`),
        ).toBeInTheDocument(),
      );
    });

    it("checks again by itself after the server's wait, and clears when the outage does", async () => {
      vi.useFakeTimers();
      vi.mocked(apiFetch)
        .mockRejectedValueOnce(apiError(503, DB_DOWN, 30))
        .mockResolvedValueOnce({ user: { id: "u1", email: "a@b.com", state: "ACTIVE" } });
      render(
        <AuthProvider>
          <UnavailableProbe />
        </AuthProvider>,
      );
      await act(async () => {});
      expect(screen.getByText("unavailable:30:false")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(29_000);
      });
      expect(apiFetch).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(apiFetch).toHaveBeenCalledTimes(2);
      expect(screen.getByText("authenticated:a@b.com")).toBeInTheDocument();
    });

    it("retrySessionCheck marks the state as checking while the request runs", async () => {
      vi.mocked(apiFetch).mockRejectedValueOnce(apiError(503, DB_DOWN, 30));
      render(
        <AuthProvider>
          <UnavailableProbe />
        </AuthProvider>,
      );
      await waitFor(() =>
        expect(screen.getByText("unavailable:30:false")).toBeInTheDocument(),
      );

      /** @type {(value: unknown) => void} */
      let answer = () => {};
      vi.mocked(apiFetch).mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      act(() => screen.getByRole("button", { name: "retry" }).click());
      expect(screen.getByText("unavailable:30:true")).toBeInTheDocument();

      await act(async () => answer({ user: { id: "u1", email: "a@b.com" } }));
      expect(screen.getByText("authenticated:a@b.com")).toBeInTheDocument();
    });

    it("a sign-in that lands while a re-check is in flight is not overwritten by that re-check's 503", async () => {
      vi.mocked(apiFetch).mockRejectedValueOnce(apiError(503, DB_DOWN, 30));
      render(
        <AuthProvider>
          <UnavailableProbe />
        </AuthProvider>,
      );
      await waitFor(() =>
        expect(screen.getByText("unavailable:30:false")).toBeInTheDocument(),
      );

      /** @type {(reason: unknown) => void} */
      let fail = () => {};
      vi.mocked(apiFetch).mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      );
      act(() => screen.getByRole("button", { name: "retry" }).click());
      act(() => screen.getByRole("button", { name: "simulate login" }).click());
      expect(screen.getByText("authenticated:new@b.com")).toBeInTheDocument();

      await act(async () => fail(apiError(503, DB_DOWN, 30)));
      expect(screen.getByText("authenticated:new@b.com")).toBeInTheDocument();
    });
  });

  describe("signOut (BUILD-PLAN step 39, FR-7.7/FR-1.9)", () => {
    function SignOutSimulator() {
      const auth = useAuth();
      return (
        <button type="button" onClick={() => auth.signOut()}>
          sign out
        </button>
      );
    }

    it("calls POST /api/v1/auth/logout — not just a local state clear, which would leave the httpOnly cookie (and so the session) still valid server-side", async () => {
      vi.mocked(apiFetch)
        .mockResolvedValueOnce({ user: { id: "u1", email: "a@b.com" } }) // the initial /me
        .mockResolvedValueOnce({ ok: true }); // the logout call

      render(
        <AuthProvider>
          <Probe />
          <SignOutSimulator />
        </AuthProvider>,
      );
      await waitFor(() =>
        expect(screen.getByText("authenticated:a@b.com")).toBeInTheDocument(),
      );

      await act(async () => {
        screen.getByRole("button", { name: "sign out" }).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(apiFetch).toHaveBeenLastCalledWith("/api/v1/auth/logout", {
        method: "POST",
      });
      expect(screen.getByText("unauthenticated:none")).toBeInTheDocument();
    });

    it("still clears local state even when the logout request fails — the user asked to leave", async () => {
      vi.mocked(apiFetch)
        .mockResolvedValueOnce({ user: { id: "u1", email: "a@b.com" } })
        .mockRejectedValueOnce(new Error("network error"));

      render(
        <AuthProvider>
          <Probe />
          <SignOutSimulator />
        </AuthProvider>,
      );
      await waitFor(() =>
        expect(screen.getByText("authenticated:a@b.com")).toBeInTheDocument(),
      );

      await act(async () => {
        screen.getByRole("button", { name: "sign out" }).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByText("unauthenticated:none")).toBeInTheDocument();
    });
  });
});
