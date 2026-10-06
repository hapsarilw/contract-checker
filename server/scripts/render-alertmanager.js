// The committed Alertmanager configuration with REAL receivers, for loading
// into an environment's alerting backend (BUILD-PLAN step 75,
// docs/staging-setup.md). Run where the secrets are, never committed:
//
//   PAGERDUTY_ROUTING_KEY=... DIGEST_EMAIL_TO=... DIGEST_SMTP_SMARTHOST=... \
//   DIGEST_SMTP_FROM=... DIGEST_SMTP_USERNAME=... DIGEST_SMTP_PASSWORD=... \
//     node scripts/render-alertmanager.js --out /tmp/alertmanager.yml
//
// ONLY THE RECEIVERS CHANGE. Routing, grouping, timings and inhibitions are
// ops/alerts/alertmanager.yml's, which step 68's tests and step 75's outage
// drill measured; the rendered file is checked against it before it is
// written, so the one that ships is the one that was drilled.
//
//   page     PagerDuty (Events API v2): PAGERDUTY_ROUTING_KEY. Sev 1 is sent
//            as "critical", Sev 2 as "error".
//   digest   email, through any SMTP relay (the email provider's own works):
//            DIGEST_EMAIL_TO, DIGEST_SMTP_SMARTHOST (host:port),
//            DIGEST_SMTP_FROM, DIGEST_SMTP_USERNAME, DIGEST_SMTP_PASSWORD.
//
// The output holds secrets: it is written with mode 600 and nothing else is
// done with it here. Exit 0 written, 1 refused (a value missing, or the
// result not the committed configuration), 2 bad arguments.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { parse, stringify } from "yaml";

const COMMITTED = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "ops",
  "alerts",
  "alertmanager.yml",
);

const REQUIRED = [
  "PAGERDUTY_ROUTING_KEY",
  "DIGEST_EMAIL_TO",
  "DIGEST_SMTP_SMARTHOST",
  "DIGEST_SMTP_FROM",
  "DIGEST_SMTP_USERNAME",
  "DIGEST_SMTP_PASSWORD",
];

/**
 * @param {string} committedYaml
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true, yaml: string } | { ok: false, error: string }}
 */
export function renderAlertmanager(committedYaml, env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) return { ok: false, error: `missing: ${missing.join(", ")}` };

  const committed = parse(committedYaml);
  const names = committed.receivers
    .map((/** @type {{ name: string }} */ r) => r.name)
    .sort();
  if (!isDeepStrictEqual(names, ["digest", "page"])) {
    return {
      ok: false,
      error: `expected receivers page and digest, found ${names.join(", ")}`,
    };
  }

  const rendered = structuredClone(committed);
  rendered.receivers = [
    {
      name: "page",
      pagerduty_configs: [
        {
          routing_key: env.PAGERDUTY_ROUTING_KEY,
          send_resolved: true,
          severity:
            '{{ if eq .CommonLabels.severity "1" }}critical{{ else }}error{{ end }}',
        },
      ],
    },
    {
      name: "digest",
      email_configs: [
        {
          to: env.DIGEST_EMAIL_TO,
          from: env.DIGEST_SMTP_FROM,
          smarthost: env.DIGEST_SMTP_SMARTHOST,
          auth_username: env.DIGEST_SMTP_USERNAME,
          auth_password: env.DIGEST_SMTP_PASSWORD,
          require_tls: true,
          send_resolved: true,
        },
      ],
    },
  ];

  // Everything but the receivers must still be the committed file's.
  /** @param {Record<string, unknown>} config */
  const withoutReceivers = (config) => {
    const copy = { ...config };
    delete copy.receivers;
    return copy;
  };
  if (!isDeepStrictEqual(withoutReceivers(rendered), withoutReceivers(committed))) {
    return {
      ok: false,
      error: "the rendered routing differs from ops/alerts/alertmanager.yml",
    };
  }
  return { ok: true, yaml: stringify(rendered) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let out;
  try {
    out = parseArgs({ options: { out: { type: "string" } } }).values.out;
  } catch (err) {
    console.error(String(err));
    process.exit(2);
  }
  if (!out) {
    console.error(
      "usage: node scripts/render-alertmanager.js --out FILE  (secrets from the environment)",
    );
    process.exit(2);
  }
  // An operator tool, not the application: these are the deploy
  // environment's secrets, which config.js's schema neither knows nor holds.
  // eslint-disable-next-line no-restricted-syntax -- see above
  const result = renderAlertmanager(readFileSync(COMMITTED, "utf8"), process.env);
  if (!result.ok) {
    console.error(`refused: ${result.error}`);
    process.exit(1);
  }
  writeFileSync(out, result.yaml, { encoding: "utf8", mode: 0o600 });
  console.log(`wrote ${out} (mode 600, holds secrets): load it, then delete it.`);
}
