import prisma from "./prisma.js";
import { pingRedis } from "./redis.js";

/**
 * FR-4.7 — each check is independent and structured the same way, so a
 * caller can report which dependency is down rather than a single
 * pass/fail. Redis became a real check at step 44.
 *
 * @typedef {{ ok: boolean, error?: string }} CheckResult
 */

/** @returns {Promise<CheckResult>} */
export async function checkPostgres() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * A raw connection failure (e.g. Postgres unreachable) surfaces from
 * Prisma as a PrismaClientKnownRequestError whose `.message` is generic
 * boilerplate ("Invalid `prisma.$queryRaw()` invocation:", verified
 * against a real refused connection — nothing useful appended) while the
 * actually useful detail (ECONNREFUSED, ETIMEDOUT, ...) sits on `.code`.
 * An operator staring at this at 2 a.m. needs the code, not the
 * boilerplate, so `.code` wins whenever it's present.
 */
function describeError(err) {
  if (!(err instanceof Error)) return String(err);
  const code = /** @type {{ code?: string }} */ (err).code;
  return code ?? err.message;
}

/**
 * A real PING since step 44, using the same client and the same NFR-3.7
 * timeouts as the request path — a readiness check that used its own,
 * looser connection could pass on a Redis the limiters would find
 * unusable, which is the one thing it must never do.
 *
 * Note what a failure here means now that FR-5.6 exists: NOT that the API
 * is unusable. Reads and auth fail open and keep working; only analysis
 * fails closed. Reporting the dependency as down is still right — an
 * operator needs to know, and the platform should stop sending new traffic
 * to an instance that cannot meter spend — but the per-dependency
 * breakdown (FR-4.7) is what tells them the difference between "degraded"
 * and "down", which a single boolean would not.
 *
 * @returns {Promise<CheckResult>}
 */
export async function checkRedis() {
  try {
    await pingRedis();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}
