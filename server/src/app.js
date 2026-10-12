import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import config from "./config.js";
import logger from "./observability/logger.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { httpMetricsMiddleware, metricsHandler } from "./observability/metrics.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { csrfGuard } from "./middleware/csrf.js";
import { generalLimiter } from "./middleware/rateLimits.js";
import { AppError } from "./lib/AppError.js";
import opsRouter from "./routes/ops.js";
import cspReportRouter from "./routes/cspReport.js";
import authRouter from "./routes/auth.js";
import documentsRouter from "./routes/documents.js";
import accountRouter from "./routes/account.js";
import drillsRouter from "./routes/drills.js";

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

// §6.6: every request timed, including the ones refused by CORS, the CSRF
// guard or a limiter below, which is why it sits this early. Labelled by
// route pattern at finish, once routing has happened (observability/
// metrics.js).
app.use(httpMetricsMiddleware);

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
    /**
     * FR-7.10. Retry-After is not a CORS-safelisted response header, so
     * without this the browser hides it from the SPA (which is on another
     * origin) and the client cannot tell a 60-second provider outage from
     * an hour-long spend cutoff. The degraded-mode banner's lifetime is
     * that header.
     */
    exposedHeaders: ["Retry-After"],
  }),
);

app.use(cookieParser());

/**
 * FR-7.9's violation reports (step 75). Before csrfGuard, which would
 * refuse a browser's report for its Content-Type: routes/cspReport.js says
 * why that is safe for this route and no other.
 */
app.use("/api/csp-report", cspReportRouter);

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
 * A body over this limit — or one that isn't valid JSON at all — is
 * rejected by body-parser before any route runs. See jsonBodyErrors
 * immediately below for why that needs its own translator.
 */
app.use(express.json({ limit: "1mb" }));

/**
 * Translates body-parser's own errors into the API's error vocabulary.
 * Mounted immediately after express.json(), matching how every other
 * library-specific error is translated close to where it's thrown
 * (upload.js's toAppError, pdf.js, docx.js) rather than centralised in
 * the global handler.
 *
 * This exists because of a real, previously-undiscovered gap: malformed
 * JSON (a client typo, a broken client library) and an oversized JSON
 * body BOTH threw a raw, non-AppError exception straight through to
 * errorHandler's default 500 INTERNAL — for every route that accepts a
 * JSON body, not just this one. It surfaced writing step 18's tests,
 * which happened to be the first ones in this codebase to send
 * genuinely malformed JSON rather than structurally-valid JSON with
 * semantically wrong values (which Zod already caught correctly). The
 * comment this replaced had already flagged half of this — the
 * oversized-body case — as a known gap; the unparseable-JSON case was
 * not.
 *
 * body-parser and its own raw-body dependency mark every error they
 * throw with a `.type` in one of three namespaces — verified against
 * the installed package's source rather than assumed, since guessing
 * wrong here would silently leave some of these still falling through
 * to 500:
 *   entity.*   — entity.parse.failed, entity.verify.failed, entity.too.large
 *   charset.*  — charset.unsupported
 *   encoding.* — encoding.unsupported
 * An AppError (register, login, ...) never has a `.type` property, so
 * this can't misclassify an application error as a body-parser one.
 */
app.use((err, req, res, next) => {
  const type = typeof err?.type === "string" ? err.type : "";
  const isBodyParserError =
    type.startsWith("entity.") ||
    type.startsWith("charset.") ||
    type.startsWith("encoding.");

  if (!isBodyParserError) {
    next(err);
    return;
  }

  if (type === "entity.too.large") {
    // FR-2.2's 1 MB paste cap. Reusing FILE_TOO_LARGE rather than a new
    // code: it is the only 413 in the table, the HTTP status is what
    // actually matters here, and the default message (about a 5 MB
    // file) is wrong for this case — so it's overridden rather than
    // left to imply the wrong limit.
    next(
      new AppError("FILE_TOO_LARGE", {
        message:
          "That request body is over the 1 MB limit for pasted text. Try a shorter document, or split it into sections.",
      }),
    );
    return;
  }

  // entity.parse.failed / entity.verify.failed / charset.unsupported /
  // encoding.unsupported: the body could not be read as the JSON it
  // claimed to be. Same bucket as a schema failure from the client's
  // perspective — the request body doesn't work — just caught one step
  // earlier than Zod would have.
  next(new AppError("VALIDATION_ERROR", { details: { bodyParserType: type } }));
});

/**
 * NFR-2.6's general bucket (100 requests / 15 min / IP) — the blanket
 * ceiling across all of /api/v1, mounted here rather than per-route so
 * a new route can't forget to opt in. Scoped to /api/v1 specifically,
 * NOT the ops routes mounted below at plain /api (step 8's own
 * requirement, FR-4.7: a liveness/readiness probe must never be the
 * thing that trips a rate limit and makes an orchestrator restart a
 * healthy instance). auth.js and documents.js layer their own tighter,
 * route-specific limiters (rateLimits.js's authLimiter/analyzeLimiter)
 * on top of this one for the routes NFR-2.6 singles out — a request to
 * one of those routes counts against both.
 *
 * See server/src/middleware/rateLimits.js's own file header for the
 * store choice (MemoryStore, correct for exactly one instance, replaced
 * in step 44) and why the keying here is left to express-rate-limit's
 * own default rather than reimplemented.
 */
app.use("/api/v1", generalLimiter);

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
 * Multer slot — deliberately still empty. middleware/upload.js exists
 * (step 16), but only the document-upload route needs multipart
 * parsing, so it mounts there rather than globally, at step 18. A
 * global multer would run busboy over every request that never carries
 * a file.
 */

// Ops routes — outside the /api/v1 prefix (§4): health, ready, version.
// §6.6's metrics, token-protected on the one port the platform exposes.
// See observability/metrics.js for why this is a route and not a port.
app.get("/metrics", metricsHandler);

app.use("/api", opsRouter);

// Product routes — under /api/v1 (§4).
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/documents", documentsRouter);
app.use("/api/v1/account", accountRouter);

// STAGING ONLY (step 68). Mounted only when ALERT_DRILL_TOKEN is set, which
// config.js refuses to allow in production at all — so in a real deployment
// these paths do not exist. See routes/drills.js.
if (config.ALERT_DRILL_TOKEN) {
  app.use("/api/v1/drills", drillsRouter);
  logger.warn(
    { drills: "mounted" },
    "ALERT DRILL routes are mounted — staging only, never production (step 68)",
  );
}

// Catch-all for any path that reaches here unmatched by a real route.
app.use((req, res, next) => {
  next(new AppError("NOT_FOUND"));
});

// Must be the LAST middleware registered (§4, NFR-3.2) — Express routes
// to an error handler only when it's mounted after whatever called next(err).
app.use(errorHandler);

export default app;
