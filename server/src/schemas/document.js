import { z } from "zod";

/**
 * FR-2.1 — the paste half of document intake: `{ "text": "..." }`.
 *
 * Deliberately no `.min()` on `text`. The obvious-looking
 * `z.string().min(1)` would make an empty or whitespace-only paste a 400
 * VALIDATION_ERROR — a different, less specific answer than the one
 * intake.js already gives for the same underlying problem: countWords()
 * on empty text is 0, which is under FR-2.5's 200-word floor and throws
 * 422 DOCUMENT_TOO_SHORT with a message explaining why. Adding a length
 * floor here would make paste behave differently from upload for the
 * exact same failure (an upload with an all-whitespace text layer also
 * goes through DOCUMENT_TOO_SHORT, never VALIDATION_ERROR) — one gate,
 * one code, for both intake paths.
 *
 * This schema's job is purely structural: is `text` present and a
 * string. Everything about whether it's ENOUGH text belongs to
 * intake.js, which is the single place that decision is made.
 */
export const pasteDocumentSchema = z
  .object({
    text: z.string(),
  })
  .strict();
