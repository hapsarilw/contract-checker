import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The "sink" email provider: keeps every message instead of sending it.
 *
 * It exists for two consumers named in step 51. Local development, where
 * you want to see the verification link without a mail account. And the
 * E2E tests of step 73, which have to read a single-use token out of a
 * delivered message — a real provider cannot give them that.
 *
 * TWO PLACES A MESSAGE LANDS. In memory, always, which is what integration
 * tests read. And as one JSON file per message under `dir` when one is
 * configured, which is what a SEPARATE process reads: a browser-driven E2E
 * run talks to a server in another process, so an in-memory array is
 * invisible to it, and exposing one over HTTP would be a
 * credential-leaking endpoint waiting to be enabled by mistake. A
 * directory needs no route, and config.js refuses this provider in
 * production, so it cannot end up serving one.
 *
 * The files contain recipients and single-use tokens. They are
 * development artefacts and .mail-sink/ is gitignored.
 */

/**
 * @typedef {{ id: string, at: string, to: string, from: string, subject: string, text: string, html: string }} SinkMessage
 */

/**
 * @param {{ dir?: string }} [options]
 */
export function createSinkProvider({ dir } = {}) {
  /** @type {SinkMessage[]} */
  const sent = [];

  return {
    name: "sink",

    /**
     * @param {{ to: string, from: string, subject: string, text: string, html: string }} message
     */
    async send(message) {
      /** @type {SinkMessage} */
      const record = { id: randomUUID(), at: new Date().toISOString(), ...message };
      sent.push(record);

      if (dir) {
        await mkdir(dir, { recursive: true });
        // Timestamp first so a directory listing reads in send order; the
        // uuid keeps two messages in the same millisecond apart. Neither
        // part comes from user input, so the name cannot escape `dir`.
        const name = `${record.at.replaceAll(":", "-")}-${record.id}.json`;
        await writeFile(join(dir, name), JSON.stringify(record, null, 2), "utf8");
      }
    },

    /** Everything sent so far, oldest first. */
    messages: () => [...sent],

    /** The most recent message to an address, or undefined. */
    latestTo: (/** @type {string} */ address) => [...sent].reverse().find((m) => m.to === address),

    clear: () => {
      sent.length = 0;
    },
  };
}

/**
 * The first http(s) URL in a message body — how a test or an E2E run gets
 * the verification or reset link out of a delivered message.
 *
 * @param {string} text
 */
export function extractFirstLink(text) {
  return text.match(/https?:\/\/[^\s"<>]+/)?.[0];
}
