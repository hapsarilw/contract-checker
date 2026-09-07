import { defineConfig, env } from "@prisma/config";

/**
 * Prisma 7 moved the datasource connection string out of schema.prisma
 * (the old `datasource { url = env("DATABASE_URL") }` block is rejected —
 * P1012) and into this file, for CLI commands only (generate, migrate).
 * The running PrismaClient is configured separately, via the `adapter`
 * option passed to its constructor (server/src/lib/prisma.js) — the two
 * are deliberately different mechanisms now.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
