import { z } from "zod";
import { stringify as stringifyYaml } from "yaml";
import { ERROR_CODES } from "../lib/errorCodes.js";
import { SESSION_COOKIE_NAME } from "../services/auth.js";
import {
  changeEmailSchema,
  changePasswordSchema,
  confirmEmailChangeSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "../schemas/auth.js";
import { pasteDocumentSchema } from "../schemas/document.js";
import { deleteAccountSchema } from "../schemas/account.js";

/**
 * SRS §4's API contract, step 59 (API-4).
 *
 * "the surface is described by a committed OpenAPI 3.1 document generated
 *  from the Zod schemas, so the specification cannot drift from the
 *  implementation."
 *
 * WHAT "GENERATED FROM THE ZOD SCHEMAS" MEANS HERE, PRECISELY, because the
 * phrase covers two different things and only one of them has a Zod
 * source to draw from:
 *
 *   REQUEST BODY SHAPES come from `z.toJSONSchema()` run against the
 *   EXACT schema objects `validateBody()` uses at runtime (imported here,
 *   not re-typed) — the same drift risk §4 names for a hand-maintained
 *   spec is exactly what importing the real schema object eliminates.
 *
 *   ERROR CODES come from ERROR_CODES (server/src/lib/errorCodes.js),
 *   this system's own stated single source of truth — the response
 *   schema's `code` enum is built from `Object.keys(ERROR_CODES)`, so a
 *   code added there appears here on the next generation with no second
 *   place to remember to update.
 *
 * WHAT IS NOT GENERATED, AND WHY THAT IS HONEST RATHER THAN A SHORTCUT:
 * the ROUTE TABLE below — which paths exist, which method, whether they
 * require auth, which schema (if any) validates the body — has no Zod
 * source, because Express routes and Zod schemas are two different
 * registrations in this codebase with nothing that mechanically ties one
 * to the other. That table IS hand-authored. What closes the drift risk
 * for THAT part is not generation but the CONTRACT TEST
 * (tests/unit/openapi.test.js), which walks the REAL registered routes on
 * the REAL Express app and fails if this table and the app disagree in
 * either direction — an endpoint added here that doesn't exist, or one
 * that exists and isn't here. A generated-looking table with no such
 * check would be exactly the "hand-maintained spec that drifts" §4 warns
 * against, wearing a generator's clothes.
 *
 * Response BODY shapes (as opposed to error shapes) are deliberately left
 * at `type: object` with a prose description. There is no Zod schema for
 * a response anywhere in this codebase — serializers.js builds response
 * objects imperatively — so a precisely-typed response schema here would
 * have no runtime source to be generated FROM, and would be exactly the
 * unchecked, driftable prose the rest of this file exists to avoid.
 */

/** SRS §4's versioning policy, verbatim, so it lives in the one artifact a client actually reads. */
const VERSIONING_POLICY = [
  "All endpoints are versioned under /api/v1. `/api/health`, `/api/ready` and `/api/version` sit outside the version prefix because they are operational, not product, surface.",
  "",
  "**Versioning policy:** breaking changes go to `/api/v2` with `/api/v1` supported for at least 90 days after a successor exists. Additive fields are not breaking. A response field is removed only in a new version.",
].join("\n");

/**
 * §4's error envelope, structurally: `{ error: { code, message,
 * requestId } }`. `code`'s enum is the one place in this file that is
 * ENTIRELY generated — nothing here is typed by hand.
 */
function buildErrorSchema() {
  return {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message", "requestId"],
        properties: {
          code: {
            type: "string",
            description: "One of the codes in SRS §4.2, sourced from server/src/lib/errorCodes.js.",
            enum: Object.keys(ERROR_CODES),
          },
          message: { type: "string", description: "Human-readable, safe to show the user as-is (NFR-4.3)." },
          requestId: { type: "string", description: "Echoed so a user can quote it to support (§6.5)." },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
}

/**
 * Every Zod request-body schema this API validates against, named for its
 * OpenAPI component. The name is the only hand-typed thing per entry —
 * the shape is `z.toJSONSchema(schema)`, run against the SAME schema
 * object `validateBody()` imports and uses at request time.
 */
const REQUEST_SCHEMAS = {
  RegisterRequest: registerSchema,
  LoginRequest: loginSchema,
  VerifyEmailRequest: verifyEmailSchema,
  ForgotPasswordRequest: forgotPasswordSchema,
  ResetPasswordRequest: resetPasswordSchema,
  ChangePasswordRequest: changePasswordSchema,
  ChangeEmailRequest: changeEmailSchema,
  ConfirmEmailChangeRequest: confirmEmailChangeSchema,
  PasteDocumentRequest: pasteDocumentSchema,
  DeleteAccountRequest: deleteAccountSchema,
};

/**
 * FR-2.1: POST /documents accepts multipart upload OR a pasted JSON body
 * on the same path, distinguished by Content-Type — there is no Zod
 * schema for the multipart half (multer parses it, not Zod), so unlike
 * every other requestBody in this file, this one shape genuinely has no
 * schema to generate from. Said plainly here rather than invented.
 */
const UPLOAD_DOCUMENT_MULTIPART_SCHEMA = {
  type: "object",
  description: "FR-2.1 upload path. Not Zod-validated — multer parses the multipart body directly; this shape is documentation only.",
  properties: {
    file: {
      type: "string",
      format: "binary",
      description: "PDF or DOCX, ≤ 5 MB (FR-2.2). The field name is exactly \"file\".",
    },
  },
  required: ["file"],
};

const jsonBody = (componentName) => ({
  content: { "application/json": { schema: { $ref: `#/components/schemas/${componentName}` } } },
});

/**
 * The hand-authored route table (see the file header for why this part
 * cannot be generated, and what proves it doesn't drift instead).
 * `errorPath` names, purely for a human reading the spec, the source
 * file where that operation's AppError calls live — it plays no role in
 * the contract test's reachability proof, which is driven by
 * errorCodes.js directly rather than by anything declared here.
 *
 * @typedef {{
 *   method: "get"|"post"|"delete",
 *   path: string,
 *   summary: string,
 *   tag: string,
 *   auth: boolean,
 *   successStatus: number,
 *   successDescription: string,
 *   requestBody?: { content: Record<string, { schema: unknown }> },
 *   parameters?: unknown[],
 *   extraResponses?: Record<number, string>,
 * }} RouteEntry
 */

/** @type {RouteEntry[]} */
const ROUTES = [
  // --- Auth (FR-1.x) ---
  {
    method: "post",
    path: "/api/v1/auth/register",
    summary: "Create an account",
    tag: "Auth",
    auth: false,
    successStatus: 201,
    successDescription: "Account created, session cookie set, verification email queued.",
    requestBody: jsonBody("RegisterRequest"),
  },
  {
    method: "post",
    path: "/api/v1/auth/login",
    summary: "Sign in",
    tag: "Auth",
    auth: false,
    successStatus: 200,
    successDescription: "Session cookie set.",
    requestBody: jsonBody("LoginRequest"),
  },
  {
    method: "post",
    path: "/api/v1/auth/logout",
    summary: "Sign out this browser",
    tag: "Auth",
    auth: true,
    successStatus: 200,
    successDescription: "Session cookie cleared for this browser only.",
  },
  {
    method: "post",
    path: "/api/v1/auth/logout-all",
    summary: "Sign out every session (FR-1.9)",
    tag: "Auth",
    auth: true,
    successStatus: 200,
    successDescription: "tokenVersion incremented; every session, including this one, is now invalid.",
  },
  {
    method: "get",
    path: "/api/v1/auth/me",
    summary: "The current user",
    tag: "Auth",
    auth: true,
    successStatus: 200,
    successDescription: "The authenticated user, including account state.",
  },
  {
    method: "post",
    path: "/api/v1/auth/verify-email",
    summary: "Consume an email verification token (FR-1.7)",
    tag: "Auth",
    auth: false,
    successStatus: 200,
    successDescription: "Account transitions to ACTIVE.",
    requestBody: jsonBody("VerifyEmailRequest"),
  },
  {
    method: "post",
    path: "/api/v1/auth/resend-verification",
    summary: "Resend the verification email",
    tag: "Auth",
    auth: true,
    successStatus: 200,
    successDescription: "A new verification email was sent, unless the account is already verified.",
  },
  {
    method: "post",
    path: "/api/v1/auth/forgot-password",
    summary: "Request a password reset (FR-1.8)",
    tag: "Auth",
    auth: false,
    successStatus: 202,
    successDescription: "Always 202, whether or not the address has an account (FR-1.6).",
    requestBody: jsonBody("ForgotPasswordRequest"),
  },
  {
    method: "post",
    path: "/api/v1/auth/reset-password",
    summary: "Consume a password reset token",
    tag: "Auth",
    auth: false,
    successStatus: 200,
    successDescription: "Password changed; tokenVersion incremented, signing out every session.",
    requestBody: jsonBody("ResetPasswordRequest"),
  },
  {
    method: "post",
    path: "/api/v1/auth/change-password",
    summary: "Change password (FR-1.11)",
    tag: "Auth",
    auth: true,
    successStatus: 200,
    successDescription: "Password changed; a fresh session cookie is issued for this session.",
    requestBody: jsonBody("ChangePasswordRequest"),
  },
  {
    method: "post",
    path: "/api/v1/auth/change-email",
    summary: "Request an email change (FR-1.13)",
    tag: "Auth",
    auth: true,
    successStatus: 202,
    successDescription: "A confirmation link was sent to the new address; the current address is unchanged until it is opened.",
    requestBody: jsonBody("ChangeEmailRequest"),
  },
  {
    method: "post",
    path: "/api/v1/auth/confirm-email-change",
    summary: "Confirm an email change",
    tag: "Auth",
    auth: false,
    successStatus: 200,
    successDescription: "The address changes here, and only here.",
    requestBody: jsonBody("ConfirmEmailChangeRequest"),
  },

  // --- Documents (FR-2.x, FR-3.x) ---
  {
    method: "post",
    path: "/api/v1/documents",
    summary: "Upload or paste a document (FR-2.1)",
    tag: "Documents",
    auth: true,
    successStatus: 201,
    successDescription: "Document stored.",
    requestBody: {
      content: {
        "multipart/form-data": { schema: UPLOAD_DOCUMENT_MULTIPART_SCHEMA },
        "application/json": { schema: { $ref: "#/components/schemas/PasteDocumentRequest" } },
      },
    },
    parameters: [
      {
        name: "Idempotency-Key",
        in: "header",
        required: false,
        description: "FR-3.15. A repeat within 24 hours replays the original response instead of creating a second document.",
        schema: { type: "string", maxLength: 256 },
      },
    ],
  },
  {
    method: "post",
    path: "/api/v1/documents/{id}/analyze",
    summary: "Run analysis on a document",
    tag: "Documents",
    auth: true,
    successStatus: 200,
    successDescription: "The full report.",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
  },
  {
    method: "get",
    path: "/api/v1/documents",
    summary: "List documents (FR-4.1)",
    tag: "Documents",
    auth: true,
    successStatus: 200,
    successDescription: "Reverse-chronological, cursor-paginated (§4.4).",
    parameters: [
      { name: "cursor", in: "query", required: false, schema: { type: "string" } },
      { name: "limit", in: "query", required: false, schema: { type: "integer" } },
    ],
  },
  {
    method: "get",
    path: "/api/v1/documents/{id}",
    summary: "A document with its latest analysis",
    tag: "Documents",
    auth: true,
    successStatus: 200,
    successDescription: "The document and its latest analysis, whatever that analysis's status.",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
  },
  {
    method: "delete",
    path: "/api/v1/documents/{id}",
    summary: "Permanently delete a document",
    tag: "Documents",
    auth: true,
    successStatus: 200,
    successDescription: "The document and its analyses and findings are gone (cascade).",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
  },

  // --- Account (FR-4.5, FR-4.6) ---
  {
    method: "get",
    path: "/api/v1/account/export",
    summary: "Export all of the caller's own data (FR-4.5)",
    tag: "Account",
    auth: true,
    successStatus: 200,
    successDescription: "Account metadata, every document (including raw text), analysis and finding, and the caller's own audit history. Rate limited to 3 per day per user.",
  },
  {
    method: "delete",
    path: "/api/v1/account",
    summary: "Permanently delete the account (FR-4.6)",
    tag: "Account",
    auth: true,
    successStatus: 200,
    successDescription: "Hard, cascading delete. No tombstone, no undo (D2).",
    requestBody: jsonBody("DeleteAccountRequest"),
  },

  // --- Operations (FR-4.7, FR-4.8) ---
  {
    method: "get",
    path: "/api/health",
    summary: "Liveness probe",
    tag: "Operations",
    auth: false,
    successStatus: 200,
    successDescription: "Process responsiveness only — no dependency checks (FR-4.7).",
  },
  {
    method: "get",
    path: "/api/ready",
    summary: "Readiness probe",
    tag: "Operations",
    auth: false,
    successStatus: 200,
    successDescription: "Postgres and Redis are both reachable.",
    extraResponses: { 503: "One or more dependencies are unreachable; the body names which (FR-4.7)." },
  },
  {
    method: "get",
    path: "/api/version",
    summary: "Build identity",
    tag: "Operations",
    auth: false,
    successStatus: 200,
    successDescription: "The running build's git SHA and build timestamp (FR-4.8).",
  },
];

/** Express's `:id` becomes OpenAPI's `{id}`; every ROUTES path above is already written in the OpenAPI form, so this exists for the SIDE that reads the LIVE app (the contract test), not for this file. */
export function expressPathToOpenApiPath(expressPath) {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function buildOperation(route) {
  const responses = {
    [route.successStatus]: { description: route.successDescription },
  };

  for (const [status, description] of Object.entries(route.extraResponses ?? {})) {
    responses[status] = { description };
  }

  // Every operation can fail with any of ERROR_CODES's statuses — there is
  // no per-route mapping declared anywhere in the application itself
  // (AppError's constructor takes any code, from any call site), so
  // asserting a narrower set here would be precision this file cannot
  // back up. `default` is the honest way to say "any error shape below".
  responses.default = {
    description: "An error. `error.code` is one of ERROR_CODES (server/src/lib/errorCodes.js); see ErrorResponse.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
  };

  const operation = {
    summary: route.summary,
    tags: [route.tag],
    responses,
  };

  if (route.parameters) operation.parameters = route.parameters;
  if (route.requestBody) operation.requestBody = { required: true, ...route.requestBody };
  if (route.auth) operation.security = [{ cookieAuth: [] }];

  return operation;
}

/**
 * The full document, as a plain JS object — never written to disk by
 * this module. scripts/generate-openapi.js owns the file write;
 * tests/unit/openapi.test.js calls this directly to compare against what
 * is actually committed, which is what proves the committed file is not
 * stale (SRS §4's whole point).
 */
export function buildOpenApiDocument() {
  const paths = {};
  for (const route of ROUTES) {
    paths[route.path] ??= {};
    paths[route.path][route.method] = buildOperation(route);
  }

  const schemas = { ErrorResponse: buildErrorSchema() };
  for (const [name, schema] of Object.entries(REQUEST_SCHEMAS)) {
    schemas[name] = z.toJSONSchema(schema);
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "ClauseCheck API",
      version: "1.0.0",
      description: VERSIONING_POLICY,
    },
    paths,
    components: {
      schemas,
      securitySchemes: {
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          // Sourced from services/auth.js, not retyped — the one thing
          // worse than a wrong cookie name in a hand-maintained spec is a
          // RIGHT one that silently goes wrong the next time it's renamed.
          name: SESSION_COOKIE_NAME,
        },
      },
    },
  };
}

/** Exposed for the contract test and the route table itself. */
export { ROUTES };

/** YAML, via the same document buildOpenApiDocument() returns — scripts/generate-openapi.js writes this string to docs/openapi.yaml. */
export function renderOpenApiYaml() {
  const banner =
    "# GENERATED FILE — do not hand-edit.\n" +
    "# Produced by scripts/generate-openapi.js from the Zod schemas in\n" +
    "# server/src/schemas/*.js and the error table in\n" +
    "# server/src/lib/errorCodes.js. Run `npm run generate:openapi` (from\n" +
    "# server/) after changing either, and commit the result.\n";
  return banner + stringifyYaml(buildOpenApiDocument());
}
