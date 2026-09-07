/**
 * NFR-3.5 — graceful shutdown. On SIGTERM the instance stops accepting
 * connections, finishes in-flight requests up to the drain window, closes
 * the database pool, then exits.
 *
 * The drain window (90 s) is deliberately longer than the 60 s LLM timeout
 * so a rolling deploy never severs a user's analysis mid-flight. "A deploy
 * that severs in-flight analyses is a self-inflicted error-budget burn."
 *
 * This lives in its own module rather than inline in index.js so the
 * behavior can be tested against a real server and a real in-flight
 * request (tests/integration/gracefulShutdown.test.js) instead of a
 * reimplementation of it.
 */
export function attachGracefulShutdown({
  server,
  drainMs,
  logger,
  onDrained = async () => {},
  signals = ["SIGTERM", "SIGINT"],
  exit = (code) => process.exit(code),
}) {
  let shuttingDown = false;

  async function shutdown(signal) {
    // A second signal during the drain must not restart it — an impatient
    // orchestrator sending SIGTERM twice would otherwise run onDrained
    // twice and close an already-closing pool.
    if (shuttingDown) {
      logger.warn({ signal }, "shutdown already in progress, ignoring signal");
      return;
    }
    shuttingDown = true;

    logger.info({ signal, drainMs }, "shutdown started, draining in-flight requests");

    // Fires only if the drain overruns. `unref()` keeps this timer from
    // being the thing that holds the process open once draining finishes.
    const forceExit = setTimeout(() => {
      logger.error(
        { signal, drainMs },
        "drain window expired with requests still in flight, forcing exit",
      );
      exit(1);
    }, drainMs);
    forceExit.unref();

    // server.close() stops accepting NEW connections and invokes its
    // callback once every in-flight request has finished.
    const closed = new Promise((resolve) => {
      server.close(() => resolve(undefined));
    });

    // Idle keep-alive sockets must not hold the drain open: they live
    // until keepAliveTimeout (121 s), which is longer than the 90 s drain,
    // so waiting on them would force-exit(1) every shutdown even with
    // nothing in flight.
    //
    // Node >= 19 already closes idle connections inside server.close(), so
    // on every version this project supports (engines: >=20) this call is
    // a no-op — verified on the runtime in use. It stays because the
    // invariant is load-bearing and silent: nothing else in this file
    // would fail if a future runtime went back to waiting on idle sockets.
    // Only sockets with no active request are affected either way.
    server.closeIdleConnections?.();

    await closed;

    logger.info({ signal }, "in-flight requests drained, closing dependencies");

    try {
      await onDrained();
    } catch (err) {
      logger.error({ err, signal }, "error while closing dependencies during shutdown");
      clearTimeout(forceExit);
      exit(1);
      return;
    }

    clearTimeout(forceExit);
    logger.info({ signal }, "shutdown complete");
    exit(0);
  }

  for (const signal of signals) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  // Returned for tests and for callers that want to trigger a shutdown
  // without a signal.
  return shutdown;
}
