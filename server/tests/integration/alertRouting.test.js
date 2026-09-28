import { createServer } from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

/**
 * BUILD-PLAN step 68, items 4 and 5: the alerts are routed and grouped the
 * way PRD §9's Phase 1.5 DoD requires, drilled against a REAL Alertmanager.
 *
 * WHAT THIS DRILLS AND WHAT IT DOES NOT. A real Alertmanager, running the
 * committed alertmanager.yml, receiving real alerts, delivering real webhooks
 * to a receiver that records them. So the routing, the grouping and the
 * inhibitions are proven, including the DoD's own criterion: a five-minute
 * provider outage produces ONE notification, not four. What is NOT proven is
 * that a paging PROVIDER (PagerDuty, Opsgenie, whatever is chosen) accepts
 * the payload and wakes somebody — there is no such account yet, and the
 * receivers in the committed file are placeholders. docs/alert-drills.md says
 * so plainly, and that is the part still owed to the Phase 1.5 gate.
 *
 * THE REHEARSAL CONFIG IS THE COMMITTED ONE, with two substitutions: the
 * webhook URLs (which must point at this test) and the group timings (which
 * would otherwise make the drill wait 30 seconds per scenario, and a quarter
 * of an hour for the digest). Nothing else may differ, and the first test
 * below proves it by comparing the two configs with exactly those fields
 * normalised out. Without that, this could quietly be drilling a config
 * nobody deploys.
 */

const ALERTMANAGER_IMAGE = "prom/alertmanager:v0.28.1";
const ALERTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "ops", "alerts");
const COMMITTED = readFileSync(join(ALERTS_DIR, "alertmanager.yml"), "utf8");

/** Long enough for a container to start on a cold CI runner. */
const READY_TIMEOUT_MS = 30_000;
const WEBHOOK_TIMEOUT_MS = 15_000;

/**
 * @typedef {{ receiver: string, status: string, groupLabels: Record<string, string>,
 *   alerts: { labels: Record<string, string>, status: string }[] }} Notification
 */

/**
 * The committed config with only the URLs and the group timings replaced.
 *
 * @param {string} webhookBase
 */
function rehearsalConfig(webhookBase) {
  const config = parse(COMMITTED);
  for (const receiver of config.receivers) {
    for (const webhook of receiver.webhook_configs) {
      webhook.url = `${webhookBase}/${receiver.name}`;
    }
  }
  for (const route of [config.route, ...config.route.routes]) {
    route.group_wait = "1s";
    route.group_interval = "1s";
    // Long enough that nothing repeats mid-drill: a repeat would look like a
    // second notification and fail the "one alert" assertion for the wrong
    // reason.
    route.repeat_interval = "1h";
  }
  return stringify(config);
}

/** Both configs with the substituted fields blanked, for comparison. */
function withoutSubstitutedFields(yamlText) {
  const config = parse(yamlText);
  for (const receiver of config.receivers) {
    for (const webhook of receiver.webhook_configs) webhook.url = "<url>";
  }
  for (const route of [config.route, ...config.route.routes]) {
    route.group_wait = "<t>";
    route.group_interval = "<t>";
    route.repeat_interval = "<t>";
  }
  return config;
}

/** @type {{ stop: () => Promise<void>, notifications: Notification[], baseUrl: string } | null} */
let receiver = null;
/** @type {string | null} */
let containerId = null;
/** @type {string} */
let alertmanagerUrl;
/** @type {string} */
let workDir;

/** A local HTTP server that records every webhook Alertmanager delivers. */
async function startReceiver() {
  /** @type {Notification[]} */
  const notifications = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        notifications.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        // A malformed body is a failure of this test's own harness; the
        // assertions below will report it as a missing notification.
      }
      res.writeHead(200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    notifications,
    // Alertmanager runs in a container, so it reaches this process through
    // the host gateway rather than localhost.
    baseUrl: `http://host.docker.internal:${port}`,
    stop: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

/** @param {string} url */
async function waitForReady(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`${url}/-/ready`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`alertmanager never became ready at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Every alert fired so far, so a scenario can start from a clean slate. */
const fired = [];

/**
 * Sends alerts as a Prometheus server would.
 *
 * @param {{ alertname: string, severity: string, route: string, domain: string, owner?: string }[]} alerts
 * @param {{ resolved?: boolean }} [options]
 */
async function fire(alerts, { resolved = false } = {}) {
  const now = Date.now();
  const body = alerts.map((labels) => ({
    labels: { owner: "maintainer", ...labels },
    annotations: { summary: `${labels.alertname} (drill)` },
    startsAt: new Date(now - 60_000).toISOString(),
    // An endsAt in the past resolves the alert, which is how a scenario
    // stops the previous one's alerts from inhibiting its own.
    ...(resolved ? { endsAt: new Date(now - 1000).toISOString() } : {}),
  }));
  const res = await fetch(`${alertmanagerUrl}/api/v2/alerts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, await res.text().catch(() => "")).toBe(200);
  if (!resolved) fired.push(...alerts);
}

/**
 * Resolves everything earlier scenarios left firing. Without this, a
 * suppression proven in one scenario would silently change the next one's
 * result — which is the kind of test-order coupling that makes a suite stop
 * meaning anything.
 */
async function resolveEverything() {
  if (fired.length === 0) return;
  await fire(fired.splice(0), { resolved: true });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  receiver?.notifications.splice(0);
}

/**
 * Fires `alerts` and waits until every one of `expected` has appeared in some
 * notification, or fails saying which never arrived.
 *
 * @param {{ alertname: string, severity: string, route: string, domain: string }[]} alerts
 * @returns {Promise<Map<string, string>>} alertname to the receiver it reached
 */
async function fireAndCollect(alerts) {
  await fire(alerts);
  const expected = new Set(alerts.map((a) => a.alertname));
  /** @type {Map<string, string>} */
  const seen = new Map();
  const deadline = Date.now() + WEBHOOK_TIMEOUT_MS;
  for (;;) {
    for (const notification of receiver?.notifications ?? []) {
      for (const alert of notification.alerts) {
        if (alert.status === "firing") seen.set(alert.labels.alertname, notification.receiver);
      }
    }
    if ([...expected].every((name) => seen.has(name))) return seen;
    if (Date.now() > deadline) {
      const missing = [...expected].filter((name) => !seen.has(name));
      throw new Error(`these alerts never arrived anywhere: ${missing.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Every alert defined as code, with the labels its rule really carries. */
function catalogue() {
  const rules = parse(readFileSync(join(ALERTS_DIR, "alerts.yml"), "utf8"));
  const ci = parse(readFileSync(join(ALERTS_DIR, "ci-alerts.yml"), "utf8"));
  return [
    ...rules.groups.flatMap((/** @type {{ rules: any[] }} */ group) =>
      group.rules.map((rule) => ({ alertname: rule.alert, ...rule.labels })),
    ),
    ...ci.alerts.map((/** @type {any} */ alert) => ({ alertname: alert.alert, ...alert.labels })),
  ];
}

/** The alerts some inhibition can suppress, which must be drilled on their own. */
const INHIBITED = new Set([
  "analysis_failure_rate",
  "api_5xx_rate",
  "analysis_latency_p95",
  "db_pool_saturated",
  "spend_ceiling_80",
]);

/**
 * Waits for the notifications of one group, then a little longer, so that a
 * SECOND notification for the same incident would be caught rather than
 * missed by returning early.
 *
 * @param {string} domain
 * @returns {Promise<Notification[]>}
 */
async function notificationsFor(domain) {
  const all = () =>
    /** @type {Notification[]} */ (receiver?.notifications ?? []).filter(
      (n) => n.groupLabels.domain === domain,
    );
  const deadline = Date.now() + WEBHOOK_TIMEOUT_MS;
  while (all().length === 0) {
    if (Date.now() > deadline) throw new Error(`no notification for domain=${domain} arrived`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  // group_interval is 1s in the rehearsal, so 3 s is three chances for a
  // second notification to show up if the grouping is not doing its job.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return all();
}

const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

describe.skipIf(!dockerAvailable)("Appendix C's alerts, routed by a real Alertmanager", () => {
  beforeAll(async () => {
    receiver = await startReceiver();
    workDir = await mkdtemp(join(tmpdir(), "clausecheck-alertmanager-"));
    await writeFile(join(workDir, "alertmanager.yml"), rehearsalConfig(receiver.baseUrl));

    containerId = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-d",
        // Published on an ephemeral host port so a second run, or anything
        // else already on 9093, cannot collide.
        "-p",
        "127.0.0.1:0:9093",
        // Docker Desktop provides host.docker.internal; on Linux it has to
        // be asked for.
        "--add-host",
        "host.docker.internal:host-gateway",
        "-v",
        `${workDir}:/etc/alertmanager`,
        ALERTMANAGER_IMAGE,
        "--config.file=/etc/alertmanager/alertmanager.yml",
        "--storage.path=/tmp/alertmanager",
      ],
      { encoding: "utf8" },
    ).trim();
    const mapped = execFileSync("docker", ["port", containerId, "9093/tcp"], { encoding: "utf8" })
      .trim()
      .split("\n")[0];
    alertmanagerUrl = `http://127.0.0.1:${mapped.split(":").pop()}`;
    await waitForReady(alertmanagerUrl);
  }, 90_000);

  afterAll(async () => {
    if (containerId) spawnSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
    await receiver?.stop();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("is drilling the committed config: only the URLs and the timings differ", () => {
    expect(withoutSubstitutedFields(rehearsalConfig("http://example.invalid"))).toEqual(
      withoutSubstitutedFields(COMMITTED),
    );
  });

  it("every alert in the catalogue reaches its destination (PRD §9 DoD 5)", async () => {
    // Appendix C's nineteen, fired deliberately and observed to arrive. In
    // two batches, because five of them are suppressed whenever their cause
    // is also firing, and a drill that never delivered them would be proving
    // the inhibitions rather than the routing.
    const all = catalogue();
    expect(all).toHaveLength(19);

    await resolveEverything();
    const suppressible = await fireAndCollect(all.filter((a) => INHIBITED.has(a.alertname)));

    await resolveEverything();
    const rest = await fireAndCollect(all.filter((a) => !INHIBITED.has(a.alertname)));

    const delivered = new Map([...suppressible, ...rest]);
    expect([...delivered.keys()].sort()).toEqual(all.map((a) => a.alertname).sort());
    // And each to the destination Appendix C names, not merely somewhere.
    for (const alert of all) {
      expect(delivered.get(alert.alertname), alert.alertname).toBe(alert.route);
    }
  }, 90_000);

  it("a five-minute provider outage produces ONE page, naming the cause (PRD §9 DoD 3)", async () => {
    await resolveEverything();
    // Everything a provider outage sets off at once: the breaker (the cause),
    // analyses failing, the 5xx rate (analyze answers 503), and latency.
    await fire([
      { alertname: "circuit_open", severity: "2", route: "page", domain: "provider" },
      { alertname: "analysis_failure_rate", severity: "2", route: "page", domain: "provider" },
      { alertname: "api_5xx_rate", severity: "2", route: "page", domain: "platform" },
      { alertname: "analysis_latency_p95", severity: "3", route: "digest", domain: "quality" },
    ]);

    const pages = await notificationsFor("provider");
    expect(pages).toHaveLength(1);
    expect(pages[0].receiver).toBe("page");
    // And it says which thing broke, not four things.
    expect(pages[0].alerts.map((a) => a.labels.alertname)).toEqual(["circuit_open"]);

    // The symptoms in other domains are suppressed entirely, so there is no
    // second page and no digest to read past in the morning either.
    const others = /** @type {Notification[]} */ (receiver?.notifications ?? []).filter(
      (n) => n.groupLabels.domain !== "provider",
    );
    expect(others).toEqual([]);
  }, 60_000);

  it("a Sev-1 is never suppressed, however much else is firing", async () => {
    await resolveEverything();
    await fire([
      { alertname: "unverified_excerpt_displayed", severity: "1", route: "page", domain: "safety" },
      { alertname: "cross_user_access", severity: "1", route: "page", domain: "safety" },
    ]);

    const pages = await notificationsFor("safety");
    expect(pages).toHaveLength(1);
    expect(pages[0].receiver).toBe("page");
    // Both, in one notification: they share a destination and a cause, and an
    // operator woken for one should see the other immediately.
    expect(pages[0].alerts.map((a) => a.labels.alertname).sort()).toEqual([
      "cross_user_access",
      "unverified_excerpt_displayed",
    ]);
  }, 60_000);

  it("at the spend ceiling, the 80% digest is suppressed and only the page arrives", async () => {
    await resolveEverything();
    await fire([
      { alertname: "spend_ceiling_100", severity: "2", route: "page", domain: "cost" },
      { alertname: "spend_ceiling_80", severity: "3", route: "digest", domain: "cost" },
    ]);

    const notifications = await notificationsFor("cost");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].receiver).toBe("page");
    expect(notifications[0].alerts.map((a) => a.labels.alertname)).toEqual(["spend_ceiling_100"]);
  }, 60_000);

  it("a Sev-3 on its own goes to the digest and never to the pager", async () => {
    await resolveEverything();
    await fire([
      { alertname: "stale_pending_analyses", severity: "3", route: "digest", domain: "jobs" },
      { alertname: "retention_job_stale", severity: "3", route: "digest", domain: "jobs" },
    ]);

    const notifications = await notificationsFor("jobs");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].receiver).toBe("digest");
    expect(notifications[0].alerts.map((a) => a.labels.alertname).sort()).toEqual([
      "retention_job_stale",
      "stale_pending_analyses",
    ]);
  }, 60_000);
});
