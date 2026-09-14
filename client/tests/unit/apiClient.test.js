import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/navigate.js", () => ({ navigateTo: vi.fn() }));

const { navigateTo } = await import("../../src/lib/navigate.js");
const { apiFetch, ApiError } = await import("../../src/api/client.js");

/**
 * A minimal stand-in for the fields apiFetch actually reads off a
 * Response — real `Response` objects are awkward to construct in a test
 * (a real `new Response(...)` doesn't let `.ok`/`.status` be set
 * independently of a real status code), so this is cast to `Response`
 * rather than built as one; TypeScript checks apiFetch's OWN use of
 * `fetch`'s return value against the full type elsewhere, so nothing
 * here weakens that.
 * @param {{ status?: number, body?: unknown, ok?: boolean }} [init]
 * @returns {Response}
 */
function jsonResponse({ status = 200, body = {}, ok } = {}) {
  return /** @type {Response} */ ({
    ok: ok ?? (status >= 200 && status < 300),
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
  });
}

/**
 * `fetch`'s second call argument is `RequestInit | undefined` — every
 * call this file makes provides one, so this narrows that away instead
 * of repeating a non-null assertion at each call site.
 * @param {number} [callIndex]
 * @returns {RequestInit}
 */
function fetchCallInit(callIndex = 0) {
  const init = vi.mocked(fetch).mock.calls[callIndex][1];
  if (!init) throw new Error(`fetch call ${callIndex} had no init argument`);
  return init;
}

describe("apiFetch (BUILD-PLAN step 31, FR-7.7/7.11/7.12)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("always sends credentials: 'include' — the session is a cookie, never a client-held token", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ body: { ok: true } }));
    await apiFetch("/api/v1/auth/me");
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("calls the configured API origin with the given path", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ body: { ok: true } }));
    await apiFetch("/api/v1/auth/me");
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toMatch(/\/api\/v1\/auth\/me$/);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "sets Content-Type: application/json on a bodyless %s request",
    async (method) => {
      // The exact failure mode step 31 names: a bare
      // fetch(url, { method: "POST" }) sends no Content-Type at all,
      // which the server's CSRF guard (step 14) then rejects with 403
      // CSRF_CHECK_FAILED — logout is exactly this shape.
      vi.mocked(fetch).mockResolvedValue(jsonResponse({ body: { ok: true } }));
      await apiFetch("/api/v1/auth/logout", { method });
      const headers = new Headers(fetchCallInit().headers);
      expect(headers.get("Content-Type")).toBe("application/json");
    },
  );

  it("does not set Content-Type on a GET (a safe method has no CSRF requirement to satisfy)", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ body: { ok: true } }));
    await apiFetch("/api/v1/auth/me");
    const headers = new Headers(fetchCallInit().headers);
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("JSON-serialises a plain-object body", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ body: { ok: true } }));
    await apiFetch("/api/v1/auth/login", {
      method: "POST",
      body: { email: "a@b.com", password: "hunter2hunter2" },
    });
    expect(fetchCallInit().body).toBe(
      JSON.stringify({ email: "a@b.com", password: "hunter2hunter2" }),
    );
  });

  it("never overrides Content-Type for a FormData body, and lets the browser set its own", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ body: { ok: true } }));
    const formData = new FormData();
    formData.set("file", new Blob(["x"]), "contract.pdf");
    await apiFetch("/api/v1/documents", { method: "POST", body: formData });
    const init = fetchCallInit();
    const headers = new Headers(init.headers);
    expect(headers.has("Content-Type")).toBe(false);
    expect(init.body).toBe(formData);
  });

  it("resolves with the parsed JSON body on success", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ body: { user: { id: "u1" } } }));
    await expect(apiFetch("/api/v1/auth/me")).resolves.toEqual({ user: { id: "u1" } });
  });

  it("throws an ApiError carrying code/message/requestId for a well-formed error response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        status: 422,
        body: {
          error: { code: "VALIDATION_ERROR", message: "Bad input", requestId: "req_1" },
        },
      }),
    );
    const err = await apiFetch("/api/v1/auth/register", {
      method: "POST",
      body: {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Bad input",
      requestId: "req_1",
      status: 422,
    });
  });

  it("wraps a transport failure (offline, CORS, DNS) into the same ApiError type, with no requestId", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await apiFetch("/api/v1/auth/me").catch((e) => e);
    if (!(err instanceof ApiError)) throw new Error("expected an ApiError");
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.requestId).toBeUndefined();
  });

  describe("session expiry (FR-7.12)", () => {
    it.each(["UNAUTHENTICATED", "SESSION_REVOKED"])(
      "a 401 %s redirects to /login with a reason and the current path as returnTo",
      async (code) => {
        vi.mocked(fetch).mockResolvedValue(
          jsonResponse({
            status: 401,
            body: { error: { code, message: "x", requestId: "req_2" } },
          }),
        );

        await apiFetch("/api/v1/documents").catch(() => {});

        expect(navigateTo).toHaveBeenCalledTimes(1);
        const [url] = vi.mocked(navigateTo).mock.calls[0];
        expect(url).toMatch(/^\/login\?/);
        const params = new URLSearchParams(url.split("?")[1]);
        // An explanatory reason (FR-7.12: "an explanatory message"), not
        // a silent bounce — the login screen (step 32) turns this into
        // copy. And a return path, so signing back in doesn't strand
        // the user at /login with nowhere to go back to.
        expect(params.get("reason")).toBe("session_expired");
        expect(params.get("returnTo")).toBe(
          window.location.pathname + window.location.search,
        );
      },
    );

    it("still throws the ApiError after redirecting — the redirect doesn't swallow the failure", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          status: 401,
          body: { error: { code: "SESSION_REVOKED", message: "x", requestId: "req_3" } },
        }),
      );
      await expect(apiFetch("/api/v1/documents")).rejects.toBeInstanceOf(ApiError);
    });

    it("does NOT redirect on a 401 with an unrelated code", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          status: 401,
          body: { error: { code: "SOME_OTHER_401", message: "x" } },
        }),
      );
      await apiFetch("/api/v1/documents").catch(() => {});
      expect(navigateTo).not.toHaveBeenCalled();
    });

    it("dispatches a clausecheck:session-expired event for any future in-memory state to clear itself on", async () => {
      const listener = vi.fn();
      window.addEventListener("clausecheck:session-expired", listener);
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          status: 401,
          body: { error: { code: "SESSION_REVOKED", message: "x" } },
        }),
      );

      await apiFetch("/api/v1/documents").catch(() => {});

      expect(listener).toHaveBeenCalledTimes(1);
      window.removeEventListener("clausecheck:session-expired", listener);
    });
  });

  describe("FR-7.7 — nothing this module does touches localStorage/sessionStorage", () => {
    it("after a successful call, an error response, and a session-expiry redirect", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ body: { user: { id: "u1" } } }))
        .mockResolvedValueOnce(
          jsonResponse({ status: 422, body: { error: { code: "VALIDATION_ERROR" } } }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ status: 401, body: { error: { code: "SESSION_REVOKED" } } }),
        );

      await apiFetch("/api/v1/auth/me");
      await apiFetch("/api/v1/auth/register", { method: "POST", body: {} }).catch(
        () => {},
      );
      await apiFetch("/api/v1/documents").catch(() => {});

      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    });
  });
});
