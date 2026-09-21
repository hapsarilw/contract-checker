import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { execFileSync } from "node:child_process";

/**
 * SRS §2.3 / §10 — one ephemeral Postgres for the whole integration run,
 * not one per file: starting a container takes ~1-2s even with a cached
 * image, and every integration test file paying that cost individually
 * is the thing this module exists to avoid.
 *
 * Vitest runs `setup()` once, in the main process, before any test file
 * loads, and propagates `process.env` mutations made here to the workers
 * that actually run the tests — verified directly against this Vitest
 * version rather than assumed, since the propagation mechanism isn't
 * something to guess at. Setting DATABASE_URL here means config.js (a
 * frozen singleton, resolved once at import time) picks up the REAL
 * container's connection string the first time anything imports it —
 * before tests/setup.js's `??=` placeholder would apply.
 *
 * Redis arrived at step 44 and is set up the same way, for the same
 * reason. It holds the rate-limit counters (FR-5.6), and the per-test
 * reset is a FLUSHDB (middleware/rateLimits.js) — which is only safe
 * because this instance is created for the test run and holds nothing
 * else. Pointing the suite at a developer's own Redis would make that
 * reset destructive.
 */
let container;
let redisContainer;

export async function setup() {
  // Started together: two sequential container starts is the one part of
  // the integration run that is pure waiting.
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer("postgres:15-alpine").start(),
    new RedisContainer("redis:7-alpine").start(),
  ]);
  container = postgres;
  redisContainer = redis;

  const databaseUrl = container.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisContainer.getConnectionUrl();

  // `migrate deploy` applies exactly what production applies, including
  // the hand-written FR-3.8 partial-index migration — building the
  // schema any other way would test a fiction.
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
}

export async function teardown() {
  await Promise.all([container?.stop(), redisContainer?.stop()]);
}
