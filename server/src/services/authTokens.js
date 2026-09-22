import { createHash, randomBytes } from "node:crypto";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/AppError.js";

/**
 * Single-use authentication tokens: email verification now (FR-1.7),
 * password reset at step 53 (FR-1.8). One implementation, so the properties
 * that matter cannot drift between two copies.
 *
 * THE PLAINTEXT EXISTS IN ONE PLACE. A token is 32 bytes from a CSPRNG,
 * base64url-encoded, and it is handed to the caller exactly once — to be
 * put in an email. The database stores only its SHA-256, so a leaked
 * backup or a read-only SQL injection yields hashes that cannot be turned
 * back into working links. SHA-256 with no salt is right for THIS secret
 * and would be wrong for a password: the input is 256 bits of randomness,
 * so there is nothing to guess and no dictionary to precompute, which is
 * what a salt and a slow hash exist to defend against.
 *
 * SINGLE USE IS ENFORCED BY THE DATABASE, in one statement. Checking
 * `usedAt` and then setting it is a check-then-act race: two requests
 * carrying the same token both read "unused" and both succeed. The
 * consume below is one conditional UPDATE — unused, unexpired, right
 * type — and only the request whose UPDATE actually changed a row wins.
 * The same reasoning as FR-3.8's partial unique index: a guard against a
 * race has to live where the race is decided.
 */

/**
 * FR-1.7, FR-1.8 and FR-1.13. A type with no entry here is a programming
 * error, and the guard in issueAuthToken exists because of how quietly it
 * fails without one: `now + undefined` is NaN, which becomes an Invalid
 * Date, which Prisma rejects — surfacing as a 500 from whatever route
 * happened to call it, with nothing in the message pointing at the
 * missing line. Exactly that happened when EMAIL_CHANGE was added.
 */
export const TOKEN_TTL_MS = Object.freeze({
  EMAIL_VERIFICATION: 24 * 60 * 60 * 1000,
  // Much shorter, deliberately: a live reset link is an account takeover
  // waiting to happen, where a live verification link is not.
  PASSWORD_RESET: 30 * 60 * 1000,
  EMAIL_CHANGE: 24 * 60 * 60 * 1000,
});

/** 32 bytes, per FR-1.7. */
const TOKEN_BYTES = 32;

/** @param {string} token */
export const hashToken = (token) => createHash("sha256").update(token, "utf8").digest("hex");

/** @typedef {import("@prisma/client").AuthTokenType} AuthTokenType */

/**
 * Creates a token for a user and returns its PLAINTEXT — the only time it
 * is ever available. Callers put it in an email and drop it.
 *
 * @param {string} userId
 * @param {AuthTokenType} type
 * @param {{ now?: Date, db?: Pick<typeof prisma, "authToken"> }} [options]
 */
export async function issueAuthToken(userId, type, { now = new Date(), db = prisma } = {}) {
  const ttl = TOKEN_TTL_MS[type];
  if (typeof ttl !== "number") {
    throw new Error(`issueAuthToken: no TTL configured for token type "${type}" — add one to TOKEN_TTL_MS`);
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  await db.authToken.create({
    data: {
      userId,
      type,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + ttl),
    },
  });
  return token;
}

/**
 * One answer for every way a token can be unusable — never seen, already
 * used, expired, or the wrong kind. Distinguishing them would tell a
 * caller which of those it is, and for a secret that is a small oracle for
 * no benefit: the remedy is identical (ask for a new one).
 */
const UNUSABLE = () =>
  new AppError("VALIDATION_ERROR", {
    message:
      "This link is invalid, has already been used, or has expired. Request a new one and try again.",
    details: { reason: "token_unusable" },
  });

/**
 * Consumes a token, returning who it belongs to. Takes a transaction
 * client so the caller can make the consume and whatever it unlocks ONE
 * transaction: if the follow-up fails, the token is not burned.
 *
 * @param {Pick<typeof prisma, "authToken">} tx
 * @param {string} token
 * @param {AuthTokenType} type
 * @param {Date} [now]
 * @returns {Promise<{ userId: string }>}
 */
export async function consumeAuthToken(tx, token, type, now = new Date()) {
  const tokenHash = hashToken(token);

  const { count } = await tx.authToken.updateMany({
    where: { tokenHash, type, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (count !== 1) throw UNUSABLE();

  const row = await tx.authToken.findUniqueOrThrow({
    where: { tokenHash },
    select: { userId: true },
  });
  return { userId: row.userId };
}
