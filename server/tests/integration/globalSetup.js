import { PostgreSqlContainer } from "@testcontainers/postgresql";
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
 * Redis has no equivalent here yet — that slot arrives at step 44.
 */
let container;

export async function setup() {
  container = await new PostgreSqlContainer("postgres:15-alpine").start();
  const databaseUrl = container.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;

  // `migrate deploy` applies exactly what production applies, including
  // the hand-written FR-3.8 partial-index migration — building the
  // schema any other way would test a fiction.
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
}

export async function teardown() {
  await container?.stop();
}
