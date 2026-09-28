/**
 * Server bootstrap.
 *
 * THE TIMEOUT ORDERING THAT MUST HOLD END TO END (FR-3.6, FR-3.7, NFR-3.5):
 *
 *   platform proxy timeout          (verify in staging — not set here)
 *     > server request timeout      120 s   config.timeouts.serverRequest
 *       > analyze ceiling            90 s   config.timeouts.analyzeCeiling
 *         > LLM timeout              60 s   config.timeouts.llm
 *
 * Every link must exceed the one below it. Violate it anywhere and a long
 * analysis is cut off by an outer layer while an inner one is still
 * working — which surfaces as an intermittent, unattributable failure
 * that looks like a provider problem.
 *
 * config.js enforces the bottom two links at boot (LLM_TIMEOUT_MS is the
 * only env-tunable one, so it is the only one that can break the chain).
 * The top link — the platform's own proxy — is outside this process's
 * reach entirely: FR-3.7 requires it be VERIFIED IN STAGING, not assumed,
 * which is why the boot log below states the configured values. A
 * 30-second platform default silently truncates every long analysis and
 * the failure looks like a client disconnect.
 *
 * NOT HERE: database migrations. §5.5 forbids running them at boot —
 * with two or more instances they race. They run as a discrete CI step
 * before the deploy. If `prisma migrate deploy` ever appears in this file
 * or in `npm start`, that is the bug.
 */
import app from "./app.js";
import config from "./config.js";
import logger from "./observability/logger.js";
import prisma from "./lib/prisma.js";
import { attachGracefulShutdown } from "./lib/gracefulShutdown.js";
import { flushEmails } from "./lib/email.js";
import { closeRedis } from "./lib/redis.js";
import { startReaper, stopReaper } from "./jobs/reaper.js";
import { startRetentionJob, stopRetentionJob } from "./jobs/retention.js";
import { startQuotaResetJob, stopQuotaResetJob } from "./jobs/quotaReset.js";
import { shouldScheduleBackupVerify, startBackupVerifyJob, stopBackupVerifyJob } from "./jobs/backupVerify.js";
import { startTracing } from "./observability/tracing.js";

// §6.6's traces. A no-op without OTEL_EXPORTER_OTLP_ENDPOINT.
const stopTracing = startTracing({
  endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  version: config.GIT_SHA,
});

const server = app.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      nodeEnv: config.NODE_ENV,
      model: config.ANTHROPIC_MODEL,
      timeouts: config.timeouts,
    },
    "server listening — verify the platform proxy timeout exceeds timeouts.serverRequest (FR-3.7)",
  );
});

// FR-3.7: all three must exceed the analyze ceiling, not merely the LLM
// timeout, or the socket is torn down while the analysis is still running.
server.timeout = config.timeouts.serverRequest;
server.requestTimeout = config.timeouts.serverRequest;
server.keepAliveTimeout = config.timeouts.keepAlive;
server.headersTimeout = config.timeouts.headers;

// FR-3.8 / §12.3 — started once the server is accepting requests, not
// before: the reaper's first tick is a real database write, and there is
// no reason for it to race the server's own boot.
const reaperHandle = startReaper();
// FR-4.4 — checks every 15 minutes whether tonight's run is due; see
// jobs/retention.js for why "nightly" is a due-check and not a timer.
const retentionHandle = startRetentionJob();
// §12.3's monthly quota roll. Hourly due-check, for the same reason as
// retention: see jobs/quotaReset.js.
const quotaResetHandle = startQuotaResetJob();
// §12.3's weekly backup check. Scheduled in production whether or not a
// backup directory is configured (unconfigured there is a FAILURE that
// pages, never a skip), and in development only when one is given.
const backupVerifyHandle = shouldScheduleBackupVerify() ? startBackupVerifyJob() : undefined;
if (!backupVerifyHandle) {
  logger.info("backup verification not scheduled: no BACKUP_DIR in a non-production environment");
}

attachGracefulShutdown({
  server,
  drainMs: config.timeouts.shutdownDrain,
  logger,
  // NFR-3.5: the database pool closes after the drain and before exit —
  // never before, or an in-flight request's own query fails mid-drain
  // instead of finishing. This was a stub ("step 9 creates the client")
  // left unfilled after step 9 actually did (server/src/lib/prisma.js);
  // found and fixed while verifying step 40's "SIGTERM drains and exits
  // 0" against a real container, where an unclosed pool is exactly the
  // kind of gap that looks fine until something checks for it.
  // Both dependencies, not just the database: an open Redis connection
  // keeps the event loop alive, so SIGTERM would drain cleanly and then
  // hang until the orchestrator's kill timer fired.
  onDrained: async () => {
    // Stopped first: no new reaper tick should start once the process is
    // on its way out, and definitely not one that opens a transaction
    // after the pool below has closed.
    stopReaper(reaperHandle);
    // An in-flight retention run is not awaited: every batch it has
    // already committed stays deleted, and the next run resumes from
    // whatever is left.
    stopRetentionJob(retentionHandle);
    stopQuotaResetJob(quotaResetHandle);
    if (backupVerifyHandle) stopBackupVerifyJob(backupVerifyHandle);
    // Email next, because a message one retry from delivered is worth
    // waiting for (bounded — flushEmails gives up after five seconds).
    await flushEmails();
    // Spans still buffered in the batch processor, including the ones for
    // the requests the drain just let finish.
    await Promise.allSettled([prisma.$disconnect(), closeRedis(), stopTracing()]);
  },
});

export default server;
