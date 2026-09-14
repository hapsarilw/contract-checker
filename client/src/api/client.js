import { navigateTo } from "../lib/navigate.js";

/**
 * BUILD-PLAN step 31 — the fetch wrapper every API call in this app goes
 * through. Read FR-7.7, FR-7.11, FR-7.12 before changing this file.
 *
 * Session state lives ONLY in the httpOnly cookie the server sets
 * (FR-7.7): this module never reads or writes localStorage/sessionStorage,
 * and there is no token here for it to store even if it wanted to — the
 * SPA's only way to know who's signed in is calling GET /api/v1/auth/me.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

/** FR-1.12(d): GET/HEAD are side-effect free; everything else is state-changing. */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * SRS §4's response error shape, exactly: `{ error: { code, message,
 * requestId } }`. Thrown for both a well-formed error response AND a
 * transport failure (offline, DNS, CORS) — callers only ever have one
 * error type to catch, never a raw fetch TypeError alongside it.
 * `requestId` is undefined for a transport failure, since the request
 * never reached a server that could mint one; ErrorBoundary's "the
 * requestId when one is known" (FR-7.11) is written for exactly that
 * case.
 */
export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string | undefined} requestId
   * @param {number} status
   */
  constructor(code, message, requestId, status) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}

/**
 * FR-7.12 — "A 401 with SESSION_REVOKED or UNAUTHENTICATED on any
 * request clears client state and redirects to login with an
 * explanatory message and a return path — not a silent bounce that
 * loses the user's place."
 *
 * The message and return path travel as query parameters on the /login
 * URL: there is no client-side router yet to hand them to any other way
 * (see navigate.js), and step 32's login screen — the next thing to read
 * them — is a plain page load away from here, not a component this
 * module can pass props to.
 *
 * "Clears client state": this module holds none of its own (see the
 * file-level note on FR-7.7) — what there IS to clear lives in whatever
 * later step adds an in-memory auth/user store. A CustomEvent is
 * dispatched first so that code, whenever it exists, can react without
 * this module needing to import it (importing it the other way around
 * would be the layering violation): the redirect that follows would
 * blow the event listener away anyway on a real page load, so the event
 * only matters to a test asserting this happened, or to a future SPA
 * transition that intercepts the redirect.
 *
 * @param {string} returnPath
 */
function redirectToLogin(returnPath) {
  window.dispatchEvent(new CustomEvent("clausecheck:session-expired"));
  const url = new URL("/login", window.location.origin);
  url.searchParams.set("reason", "session_expired");
  url.searchParams.set("returnTo", returnPath);
  navigateTo(`${url.pathname}${url.search}`);
}

/**
 * @param {unknown} body
 * @returns {body is Record<string, unknown>}
 */
function isPlainObject(body) {
  return typeof body === "object" && body !== null && !(body instanceof FormData);
}

/**
 * @param {string} path e.g. "/api/v1/auth/login"
 * @param {Omit<RequestInit, "credentials" | "body"> & { body?: unknown }} [options]
 * @returns {Promise<unknown>} the parsed JSON body, or null for an empty response
 */
export async function apiFetch(path, options = {}) {
  const { body, headers: headersInit, method: methodInit, ...rest } = options;
  const method = (methodInit ?? "GET").toUpperCase();
  const headers = new Headers(headersInit);
  const isFormData = body instanceof FormData;

  // FR-1.12(c) applies to every state-changing request, bodyless ones
  // included: a bare `fetch(url, { method: "POST" })` (logout, for
  // instance) sends no Content-Type at all, which step 14's csrfGuard
  // then rejects as 403 CSRF_CHECK_FAILED. Never set on FormData,
  // though — the browser has to generate that header itself, with the
  // multipart boundary, or the server can't parse the body at all.
  if (STATE_CHANGING_METHODS.has(method) && !isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...rest,
      method,
      headers,
      // The session is an httpOnly cookie (FR-7.7) — every request, not
      // just ones that look like they need auth, so a public GET on a
      // signed-in page doesn't silently look logged out.
      credentials: "include",
      body: isPlainObject(body) ? JSON.stringify(body) : /** @type {BodyInit} */ (body),
    });
  } catch {
    // Offline, DNS failure, CORS rejection — fetch rejects with a plain
    // TypeError that carries no code, message a user could act on, or
    // requestId. Wrapped into the one error type this module ever
    // throws, per the class doc above.
    throw new ApiError(
      "NETWORK_ERROR",
      "Couldn't reach the server. Check your connection and try again.",
      undefined,
      0,
    );
  }

  const text = await response.text();
  /** @type {{ error?: { code?: string, message?: string, requestId?: string } } | null} */
  let parsed = null;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const code = parsed?.error?.code ?? "UNKNOWN_ERROR";
    const message = parsed?.error?.message ?? response.statusText;
    const requestId = parsed?.error?.requestId;

    if (
      response.status === 401 &&
      (code === "UNAUTHENTICATED" || code === "SESSION_REVOKED")
    ) {
      redirectToLogin(window.location.pathname + window.location.search);
    }

    throw new ApiError(code, message, requestId, response.status);
  }

  return parsed;
}
