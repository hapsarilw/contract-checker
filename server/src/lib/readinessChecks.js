import prisma from "./prisma.js";

/**
 * FR-4.7 — each check is independent and structured the same way, so
 * wiring in the real Redis check at step 44 is the one-line change the
 * prompt asks for: replace `checkRedis` below with a real ping.
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
 * Stubbed until step 44 (Redis-backed rate limits and quota counters).
 * Reports ok so an unwired dependency doesn't fail readiness for
 * something that isn't in the request path yet — once step 44 lands,
 * this becomes a real ping against ioredis and can fail like any other
 * check.
 *
 * @returns {Promise<CheckResult>}
 */
export async function checkRedis() {
  return { ok: true };
}
