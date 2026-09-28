import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import config from "../config.js";

/**
 * §6.1 capacity model: `instances × pool_size` must stay under the managed
 * database's connection limit with a margin — Prisma's own historical
 * default (one pool per instance with no explicit cap) silently exceeds
 * small managed-Postgres limits at three instances. DATABASE_POOL_SIZE
 * (Appendix B, default 10) is set explicitly here rather than left implicit.
 *
 * Prisma 7 configures the connection through a driver adapter rather than
 * a `?connection_limit=` query parameter on the URL (the pre-7 pattern) —
 * pool size is now a plain `pg.Pool` option (`max`), passed to the adapter.
 */
/**
 * The pool is created HERE and handed to the adapter, rather than left for
 * the adapter to create privately, so that §6.6's db_pool_in_use and
 * db_pool_waiting can read it (observability/metrics.js). Same options as
 * before; `disposeExternalPool` keeps `prisma.$disconnect()` ending it, as
 * it did when the adapter owned it.
 */
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_SIZE,
});

const adapter = new PrismaPg(pool, { disposeExternalPool: true });

const prisma = new PrismaClient({ adapter });

export default prisma;
