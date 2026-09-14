import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider } from "../../src/auth/AuthProvider.jsx";
import { useAuth } from "../../src/auth/useAuth.js";

vi.mock("../../src/api/client.js", () => ({ apiFetch: vi.fn() }));
const { apiFetch } = await import("../../src/api/client.js");

function Probe() {
  const { status, user } = useAuth();
  return <p>{`${status}:${user?.email ?? "none"}`}</p>;
}

describe("AuthProvider (BUILD-PLAN step 32, FR-7.7)", () => {
  afterEach(() => vi.clearAllMocks());

  it("starts loading, then authenticated when /me succeeds", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      user: { id: "u1", email: "a@b.com", accountState: "VERIFIED" },
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
    vi.mocked(apiFetch).mockRejectedValue(new Error("401"));

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
      user: { id: "u1", email: "a@b.com", accountState: "VERIFIED" },
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
    vi.mocked(apiFetch).mockRejectedValue(new Error("401"));

    function LoginSimulator() {
      const auth = useAuth();
      return (
        <button
          type="button"
          onClick={() =>
            auth.setUser({ id: "u2", email: "new@b.com", accountState: "UNVERIFIED" })
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
});
