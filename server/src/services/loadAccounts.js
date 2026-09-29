import { randomBytes } from "node:crypto";
import config from "../config.js";
import { AppError } from "../lib/AppError.js";
import prisma from "../lib/prisma.js";
import { SESSION_COOKIE_NAME, hashPassword, signSessionToken } from "./auth.js";

/**
 * BUILD-PLAN step 73: synthetic accounts for a load or soak run (TR-21,
 * TR-22, TR-23), created and removed through scripts/ops.js.
 *
 * WHY ACCOUNTS AND SESSIONS ARE MADE HERE, NOT BY SIGNING UP. A load run
 * needs many accounts, because NFR-2.6 limits analyses to 10 an hour per
 * user, and those limits are part of the system under test, so they stay
 * on. It cannot sign them in over HTTP either: sign-in is limited to 5
 * attempts per 15 minutes per address. So the sessions are minted here,
 * where the environment's own JWT_SECRET already is, in exactly the format
 * sign-in issues (signSessionToken). The secret never leaves the
 * environment; what leaves is a file of short-lived cookies for accounts
 * that hold nothing but synthetic documents.
 *
 * NEVER IN PRODUCTION. Refused when DEPLOY_ENV=production: production holds
 * real users, and SRS §2.3 keeps load testing to staging.
 *
 * The accounts cannot be signed into: each password is 32 random bytes,
 * hashed and then discarded. Every address is under `.invalid` (RFC 2606),
 * so no email to one of them can be delivered, and all of a run's accounts
 * share a prefix, so removing them is one statement that cannot reach an
 * account it did not create.
 */

const RUN_ID = /^[a-z0-9-]{1,32}$/;
const MAX_ACCOUNTS = 1000;

/** @param {string} run */
function prefixFor(run) {
  if (!RUN_ID.test(run)) {
    throw new AppError("VALIDATION_ERROR", {
      message: "--run must be 1 to 32 lowercase letters, digits or hyphens.",
    });
  }
  return `load-${run}-`;
}

/** @param {string | undefined} deployEnv */
function refuseInProduction(deployEnv) {
  if (deployEnv === "production") {
    throw new AppError("VALIDATION_ERROR", {
      message:
        "load accounts are refused in production (DEPLOY_ENV=production); load tests run against staging.",
    });
  }
}

/**
 * @param {{ run: string, count: number, deployEnv?: string }} options
 * @returns {Promise<{ run: string, accounts: { userId: string, email: string, cookie: string }[] }>}
 */
export async function createLoadAccounts({ run, count, deployEnv = config.DEPLOY_ENV }) {
  refuseInProduction(deployEnv);
  const prefix = prefixFor(run);
  if (!Number.isInteger(count) || count < 1 || count > MAX_ACCOUNTS) {
    throw new AppError("VALIDATION_ERROR", {
      message: `--count must be 1 to ${MAX_ACCOUNTS}.`,
    });
  }
  if ((await prisma.user.count({ where: { email: { startsWith: prefix } } })) > 0) {
    throw new AppError("VALIDATION_ERROR", {
      message: `accounts for run "${run}" already exist; remove them with load-cleanup first.`,
    });
  }

  // One hash for the run: the password it hashes is thrown away at once,
  // so sharing the hash lets nobody sign in to any of them, and 1,000
  // bcrypt rounds at production cost would take minutes for nothing.
  const passwordHash = await hashPassword(randomBytes(32).toString("hex"));
  const now = new Date();
  const emails = Array.from(
    { length: count },
    (_, i) => `${prefix}${String(i + 1).padStart(4, "0")}@load.invalid`,
  );
  await prisma.user.createMany({
    data: emails.map((email) => ({
      email,
      passwordHash,
      state: "ACTIVE",
      emailVerifiedAt: now,
    })),
  });
  const users = await prisma.user.findMany({
    where: { email: { startsWith: prefix } },
    select: { id: true, email: true, tokenVersion: true },
    orderBy: { email: "asc" },
  });
  return {
    run,
    accounts: users.map((user) => ({
      userId: user.id,
      email: user.email,
      cookie: `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`,
    })),
  };
}

/**
 * Removes a run's accounts and, by cascade, every document, analysis and
 * finding they made. Their minted sessions die with them: a session for an
 * account that no longer exists is refused.
 *
 * @param {{ run: string, deployEnv?: string }} options
 * @returns {Promise<{ removed: number }>}
 */
export async function deleteLoadAccounts({ run, deployEnv = config.DEPLOY_ENV }) {
  refuseInProduction(deployEnv);
  const prefix = prefixFor(run);
  const { count } = await prisma.user.deleteMany({
    where: { email: { startsWith: prefix, endsWith: "@load.invalid" } },
  });
  return { removed: count };
}
