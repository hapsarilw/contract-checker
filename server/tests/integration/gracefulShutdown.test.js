import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = join(__dirname, "fixtures", "slow-server.js");

/**
 * Boots the fixture server in a child process and resolves once it has
 * reported the port it's listening on.
 */
function startServer(slowMs, drainMs) {
  const child = spawn(process.execPath, [fixture, String(slowMs), String(drainMs)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server never listened. stderr: ${stderr}`)), 10_000);
    const check = setInterval(() => {
      const match = stdout.match(/LISTENING:(\d+)/);
      if (match) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    }, 10);
  });

  return { child, listening, exited, getStdout: () => stdout, getStderr: () => stderr };
}

/**
 * A request with connection pooling disabled. The default global agent
 * keeps sockets alive, which would leave an idle socket open after the
 * response and muddy what this test is actually measuring.
 */
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
  });
}

describe("graceful shutdown (NFR-3.5)", () => {
  it("lets an in-flight request complete after SIGTERM, then exits 0", async () => {
    const { child, listening, exited, getStdout } = startServer(600, 10_000);
    const port = await listening;

    // Start the slow request but do NOT await it yet — it must still be in
    // flight when the signal arrives.
    const inFlight = get(port, "/slow");

    // Give the request time to reach the handler before signalling.
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.kill("SIGTERM");

    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ completed: true });

    const { code } = await exited;
    expect(code).toBe(0);
    expect(getStdout()).toContain("DRAINED");
  }, 30_000);

  it("does not wait out keepAliveTimeout when an idle keep-alive socket is open", async () => {
    // The client below leaves an idle keep-alive socket open against a
    // server whose keepAliveTimeout is 60 s, then signals for a shutdown
    // with a 3 s drain. If idle sockets held the drain open, this would
    // overrun and force-exit(1) instead of exiting 0 promptly.
    //
    // Note this does NOT fail if closeIdleConnections() is removed: Node
    // >= 19 already closes idle connections inside server.close(). It
    // asserts the shutdown-timing property itself, which is what actually
    // matters for a rolling deploy, rather than guarding one line.
    const { child, listening, exited } = startServer(10, 3_000);
    const port = await listening;

    const agent = new http.Agent({ keepAlive: true });
    await new Promise((resolve, reject) => {
      const req = http.get({ port, path: "/slow", agent }, (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(undefined));
      });
      req.on("error", reject);
    });

    // The response is done, but the socket is still open and idle.
    const startedAt = Date.now();
    child.kill("SIGTERM");

    const { code } = await exited;
    const elapsed = Date.now() - startedAt;

    agent.destroy();
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(3_000);
  }, 30_000);

  it("ignores a second SIGTERM instead of draining twice", async () => {
    const { child, listening, exited, getStdout } = startServer(400, 10_000);
    const port = await listening;

    const inFlight = get(port, "/slow");
    await new Promise((resolve) => setTimeout(resolve, 100));

    child.kill("SIGTERM");
    child.kill("SIGTERM");

    await inFlight;
    const { code } = await exited;

    expect(code).toBe(0);
    // onDrained ran exactly once despite two signals.
    expect(getStdout().match(/DRAINED/g)).toHaveLength(1);
  }, 30_000);
});
