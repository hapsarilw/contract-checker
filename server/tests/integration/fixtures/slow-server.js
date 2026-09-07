// Spawned as a child process by tests/integration/gracefulShutdown.test.js.
//
// Uses the REAL attachGracefulShutdown from src/, not a reimplementation —
// the whole point is to prove the shipped shutdown path lets an in-flight
// request finish. Only the app and the logger are stand-ins: a slow route
// to have something in flight, and a no-op logger so the fixture doesn't
// need a validated environment just to boot.
import express from "express";
import { attachGracefulShutdown } from "../../../src/lib/gracefulShutdown.js";

const [slowMsArg, drainMsArg] = process.argv.slice(2);
const slowMs = Number(slowMsArg ?? 400);
const drainMs = Number(drainMsArg ?? 5000);

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const app = express();

app.get("/slow", async (req, res) => {
  await new Promise((resolve) => setTimeout(resolve, slowMs));
  res.json({ completed: true });
});

const server = app.listen(0, () => {
  const address = server.address();
  process.stdout.write(`LISTENING:${typeof address === "object" && address ? address.port : ""}\n`);
});

server.keepAliveTimeout = 60_000;

attachGracefulShutdown({
  server,
  drainMs,
  logger: noopLogger,
  onDrained: async () => {
    process.stdout.write("DRAINED\n");
  },
});
