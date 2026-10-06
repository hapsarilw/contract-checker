import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderAlertmanager } from "../../scripts/render-alertmanager.js";

/**
 * Step 75: the committed Alertmanager configuration with real receivers.
 * The rendered file was also checked with amtool 0.28.1 (check-config:
 * SUCCESS, 4 inhibit rules, 2 receivers); this checks what it must keep
 * and what it must refuse.
 */

const committed = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "ops",
    "alerts",
    "alertmanager.yml",
  ),
  "utf8",
);
const ENV = {
  PAGERDUTY_ROUTING_KEY: "routing-key-example",
  DIGEST_EMAIL_TO: "owner@example.test",
  DIGEST_SMTP_SMARTHOST: "smtp.example.test:587",
  DIGEST_SMTP_FROM: "alerts@example.test",
  DIGEST_SMTP_USERNAME: "user",
  DIGEST_SMTP_PASSWORD: "pass",
};

describe("renderAlertmanager", () => {
  it("pages through PagerDuty and digests by email, Sev 1 as critical", () => {
    const result = renderAlertmanager(committed, ENV);
    if (!result.ok) throw new Error(result.error);
    const config = parse(result.yaml);
    const page = config.receivers.find((r) => r.name === "page");
    const digest = config.receivers.find((r) => r.name === "digest");
    expect(page.pagerduty_configs[0].routing_key).toBe("routing-key-example");
    expect(page.pagerduty_configs[0].severity).toContain('eq .CommonLabels.severity "1"');
    expect(digest.email_configs[0]).toMatchObject({
      to: "owner@example.test",
      smarthost: "smtp.example.test:587",
      require_tls: true,
    });
    expect(result.yaml).not.toContain("REPLACE-WITH");
  });

  it("changes nothing but the receivers: the routing that was drilled is the routing that ships", () => {
    const result = renderAlertmanager(committed, ENV);
    if (!result.ok) throw new Error(result.error);
    const rendered = parse(result.yaml);
    const original = parse(committed);
    expect(rendered.route).toEqual(original.route);
    expect(rendered.inhibit_rules).toEqual(original.inhibit_rules);
    expect(rendered.global).toEqual(original.global);
  });

  it("refuses, naming every value that is missing, rather than rendering a half-configured pager", () => {
    const result = renderAlertmanager(committed, {
      ...ENV,
      PAGERDUTY_ROUTING_KEY: "",
      DIGEST_SMTP_PASSWORD: undefined,
    });
    expect(result).toEqual({
      ok: false,
      error: "missing: PAGERDUTY_ROUTING_KEY, DIGEST_SMTP_PASSWORD",
    });
  });

  it("refuses a configuration whose receivers are not the two it knows", () => {
    const changed = committed.replace("- name: digest", "- name: someone-else");
    expect(renderAlertmanager(changed, ENV)).toMatchObject({ ok: false });
  });
});
