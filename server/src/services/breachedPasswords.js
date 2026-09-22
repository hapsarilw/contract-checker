import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../lib/AppError.js";

/**
 * FR-1.2's breached-password check.
 *
 * A LOCAL LIST, NOT A RANGE API, and that is the decision rather than the
 * lazy option. FR-1.2 allows either, and the k-anonymity range API leaks
 * nothing meaningful — but it puts a third-party network call on the
 * registration and password-change paths, which buys an availability
 * dependency, a timeout to tune (NFR-3.7), and a privacy question to
 * answer in the policy, all in exchange for a longer list. A bundled list
 * has no privacy surface at all: nothing about the password, not even a
 * hash prefix, leaves this process.
 *
 * WHAT THE LIST IS WEIGHTED FOR. FR-1.2 already sets a 10-character
 * minimum, so the classic entries — "123456", "qwerty", "password" — are
 * refused by length before this is reached. A list dominated by those
 * would look thorough and block nothing the system would otherwise
 * accept, so the bundled one leans on the long common passwords that DO
 * clear the floor: "password123", "qwerty123456", "iloveyou123". Swapping
 * in a larger published list is a file replacement; nothing here reads
 * its size or ordering.
 *
 * MATCHED CASE-INSENSITIVELY. "Password123" is not meaningfully stronger
 * than "password123" — an attacker working a common-password list tries
 * the obvious capitalisations — so folding case rejects more, not less.
 */

const LIST_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "breached-passwords.txt");

/** @type {Set<string> | undefined} */
let breached;

/**
 * Read once, on first use rather than at import: this is a file read, and
 * importing a module should not do I/O (the same rule getRedis() and
 * getLlmProvider() follow).
 */
function list() {
  if (breached) return breached;
  const lines = readFileSync(LIST_PATH, "utf8").split("\n");
  breached = new Set(
    lines
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
  return breached;
}

/** @param {string} password */
export function isBreachedPassword(password) {
  return list().has(password.trim().toLowerCase());
}

/**
 * FR-1.2: "rejected with a specific message". Specific means the person
 * can tell this apart from a length rule and knows what to do about it —
 * a generic "invalid password" would read as a bug in the form.
 *
 * VALIDATION_ERROR rather than a code of its own: §4.2's table is closed,
 * and this is a rejected field value like any other. That makes the
 * MESSAGE the only thing distinguishing this from a length rejection for
 * the person reading it — `details` never reaches the response, by
 * design (errorHandler.js keeps §4's shape to code, message, requestId
 * and nothing else), so it is there for the log and not for the client.
 *
 * @param {string} password
 */
export function assertPasswordNotBreached(password) {
  if (!isBreachedPassword(password)) return;
  throw new AppError("VALIDATION_ERROR", {
    message:
      "That password appears in lists of passwords already exposed in data breaches, " +
      "so it is one of the first an attacker would try. Please choose a different one.",
    details: { field: "password", reason: "breached_password" },
  });
}
