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
import { attachGracefulShutdown } from "./lib/gracefulShutdown.js";

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

attachGracefulShutdown({
  server,
  drainMs: config.timeouts.shutdownDrain,
  logger,
  onDrained: async () => {
    // Prisma pool close slot — step 9 (DATA-1) creates the client. NFR-3.5
    // requires closing the database pool after the drain and before exit;
    // there is no pool to close until then.
  },
});

export default server;
