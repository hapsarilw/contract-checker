import { AppError } from "../lib/AppError.js";

/**
 * Validates and REPLACES req.body with the parsed result, so a route
 * handler reads normalized data (trimmed, lowercased email) rather than
 * whatever arrived on the wire. A route that reads req.body directly
 * after this has the schema's guarantees; one that reads it before does
 * not.
 *
 * The §2 diagram lists "validation" as a pipeline stage, but it is
 * per-route rather than global: each route owns its own schema, and a
 * single app-level validator would have nothing to validate against.
 *
 * Zod issues carry field paths and messages, never the submitted values
 * — which matters here more than usual, because the body being validated
 * on the auth routes contains a plaintext password. `details` stays
 * server-side regardless (errorHandler emits only code, message and
 * requestId), but the value never enters the error object in the first
 * place.
 */
export function validateBody(schema) {
  return function validateBodyMiddleware(req, res, next) {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      next(
        new AppError("VALIDATION_ERROR", {
          details: {
            issues: result.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        }),
      );
      return;
    }

    req.body = result.data;
    next();
  };
}
