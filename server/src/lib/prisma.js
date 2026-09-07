import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
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
const adapter = new PrismaPg({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_SIZE,
});

const prisma = new PrismaClient({ adapter });

export default prisma;
