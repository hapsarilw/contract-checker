import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import config from "./config.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { csrfGuard } from "./middleware/csrf.js";
import { AppError } from "./lib/AppError.js";
import opsRouter from "./routes/ops.js";
import authRouter from "./routes/auth.js";

const app = express();

/**
 * SRS §2 diagram — middleware order is specified, not incidental:
 *   requestId -> helmet/CSP -> CORS -> rate limiter -> auth -> validation
 *   -> multer -> routes -> global error handler.
 *
 * §2's second critical constraint: the API runs as two or more stateless
 * instances behind a platform proxy. Without `trust proxy`, req.ip (and
 * every IP-keyed rate limit built on it) reads the proxy's address, not
 * the client's — every user collapses onto one bucket.
 */
app.set("trust proxy", 1);

app.use(requestIdMiddleware);

app.use(
  helmet({
    /**
     * FR-7.9's directives, applied here too per NFR-2.3, as
     * defense-in-depth even though this server serves JSON, not HTML.
     * The React SPA (step 29+) carries its own copy of this policy at
     * the hosting layer, where `connect-src` also needs to name the
     * separate API origin — that detail is specific to the frontend's
     * policy and doesn't apply to the API's own CSP header, which only
     * ever needs to reference itself.
     */
    contentSecurityPolicy: {
      // Without this, helmet MERGES these directives with its own
      // defaults instead of replacing them — and helmet's default
      // style-src is `'self' https: 'unsafe-inline'`, which silently
      // reintroduces the exact thing FR-7.9 exists to forbid.
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    /**
     * NFR-2.2: one-year HSTS, production only. Sending HSTS over plain
     * HTTP in development would pin a browser to a scheme it can't
     * reach on localhost.
     */
    hsts: config.isProduction ? { maxAge: 31_536_000 } : false,
  }),
);

app.use(
  cors({
    /**
     * NFR-2.4 / FR-1.12(b): exactly one allowed origin, never a
     * wildcard, never a reflected Origin. A wildcard origin combined
     * with credentialed cookies is an account-takeover vector — any
     * site could read a logged-in user's API responses.
     */
    origin: config.FRONTEND_ORIGIN,
    credentials: true,
  }),
);

app.use(cookieParser());

/**
 * FR-1.12(c) — mounted globally rather than per-route, on purpose. A
 * security control a new route has to remember to opt into is a control
 * that will eventually be forgotten; this one applies to every
 * state-changing request by default and skips safe methods itself.
 *
 * Sits before the body parser so a rejected request is never parsed.
 */
app.use(csrfGuard);

/**
 * FR-2.2: pasted text is capped at 1 MB of JSON body. File uploads carry
 * their own, independent 5 MB limit enforced by multer at the route that
 * accepts them (step 16) — JSON and multipart bodies are mutually
 * exclusive per request, so the two limits never compete.
 *
 * A body over this limit is rejected by body-parser before any route
 * runs, as a generic (non-AppError) error — it currently falls through
 * errorHandler's default 500 INTERNAL mapping. The spec's error-code
 * table (§4.2) has no code for "pasted text too large" distinct from
 * FILE_TOO_LARGE's file-upload meaning; the intake steps (15-16) are
 * where FR-2.2's real word/byte-count validation lives, so a more
 * precise mapping belongs there if it turns out to matter.
 */
app.use(express.json({ limit: "1mb" }));

/**
 * Rate limiter slot — step 41 (OPS-2). Deliberately not wired yet: an
 * in-memory limiter would be wrong across the multi-instance deployment
 * §2's second critical constraint requires. The Redis-backed limiter
 * depends on step 44.
 */

/**
 * Auth middleware slot — step 13 (AUTH-2). Individual routes mount it
 * themselves once it exists; there is nothing global to attach here,
 * since public routes (register, login) must not require it.
 */

/**
 * Validation slot — Zod request-body validation is per-route (each
 * route owns its own schema), not a single global middleware, so there
 * is nothing to mount at the app level. Routes apply it as they're
 * built.
 */

/**
 * Multer slot — step 16 (INTAKE-2). Only the document-upload route needs
 * multipart parsing, so it is mounted there, not globally, once it
 * exists.
 */

// Ops routes — outside the /api/v1 prefix (§4): health, ready, version.
app.use("/api", opsRouter);

// Product routes — under /api/v1 (§4). Documents and account follow at
// steps 18 and 57.
app.use("/api/v1/auth", authRouter);

// Catch-all for any path that reaches here unmatched by a real route.
app.use((req, res, next) => {
  next(new AppError("NOT_FOUND"));
});

// Must be the LAST middleware registered (§4, NFR-3.2) — Express routes
// to an error handler only when it's mounted after whatever called next(err).
app.use(errorHandler);

export default app;
