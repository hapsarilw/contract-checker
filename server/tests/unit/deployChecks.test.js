import { describe, expect, it } from "vitest";
import {
  ERROR_RATIO_THRESHOLD,
  VERSION_SAMPLES,
  checkVersion,
  errorRatio,
  longAnalysis,
  longestPermittedDocument,
  watch,
} from "../../../ops/deploy/checks.mjs";

/**
 * BUILD-PLAN step 71: ops/deploy/checks.mjs, the checks deploy.yml runs
 * against a live environment. Each is exercised here against a scripted
 * fetch, for the failure SHAPES a real deploy produces: a proxy's 504, a
 * connection closed mid-request, an instance still on the old image. The
 * same checks were also run against a real proxy in the local rehearsal
 * (docs/deployment.md); this file is what keeps them honest afterwards.
 */

const BASE = "https://api.test";

/** @param {number} status @param {unknown} [body] @param {Record<string, string>} [headers] */
const json = (status, body = {}, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/**
 * A fetch that answers by "METHOD path", recording every call.
 * @param {Record<string, (init?: RequestInit) => Response | Promise<Response>>} routes
 */
function fakeFetch(routes) {
  /** @type {string[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const impl = async (input, init) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push(key);
    const route = routes[key];
    if (!route) throw new Error(`unscripted ${key}`);
    return route(init);
  };
  return { impl, calls };
}

describe("checkVersion — every instance on the expected SHA", () => {
  it("passes when every sample reports it", async () => {
    const { impl, calls } = fakeFetch({
      "GET /api/version": () => json(200, { gitSha: "new" }),
    });
    const result = await checkVersion({
      baseUrl: BASE,
      expectedSha: "new",
      fetchImpl: impl,
    });
    expect(result).toEqual({ ok: true, seen: { new: VERSION_SAMPLES } });
    expect(calls).toHaveLength(VERSION_SAMPLES);
  });

  it("fails when ONE instance behind the balancer is still on the old image", async () => {
    let n = 0;
    const { impl } = fakeFetch({
      "GET /api/version": () => json(200, { gitSha: (n += 1) === 7 ? "old" : "new" }),
    });
    const result = await checkVersion({
      baseUrl: BASE,
      expectedSha: "new",
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("old");
  });

  it("counts a non-200 or an unreachable instance as a failure, not a skip", async () => {
    const { impl } = fakeFetch({ "GET /api/version": () => json(503) });
    const result = await checkVersion({
      baseUrl: BASE,
      expectedSha: "new",
      samples: 2,
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ ok: false, seen: { "(status 503)": 2 } });

    const thrown = await checkVersion({
      baseUrl: BASE,
      expectedSha: "new",
      samples: 1,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(thrown).toMatchObject({ ok: false, seen: { "(error)": 1 } });
  });
});

describe("longestPermittedDocument", () => {
  it("stays under FR-2.6's 4,000-word cap, at a paragraph boundary", () => {
    const paragraph = Array.from({ length: 100 }, () => "word").join(" ");
    const source = Array.from({ length: 50 }, () => paragraph).join("\n\n");
    const { text, words } = longestPermittedDocument(source);
    expect(words).toBe(3_900);
    expect(text.split(/\s+/).filter(Boolean)).toHaveLength(3_900);
    expect(text.endsWith("word")).toBe(true);
  });
});

describe("longAnalysis — FR-3.7's timeout chain, through whatever is in front", () => {
  /**
   * @param {() => Response | Promise<Response>} analyze
   * @param {number} elapsedMs what the fake clock says the analyze call took
   */
  function scenario(analyze, elapsedMs) {
    const { impl, calls } = fakeFetch({
      "POST /api/v1/auth/login": () =>
        json(200, {}, { "Set-Cookie": "cc_session=abc; HttpOnly" }),
      "POST /api/v1/documents": () => json(201, { document: { id: "doc-1" } }),
      "POST /api/v1/documents/doc-1/analyze": analyze,
      "DELETE /api/v1/documents/doc-1": () => new Response(null, { status: 204 }),
    });
    let t = 0;
    const now = () => {
      const value = t;
      t += elapsedMs;
      return value;
    };
    const run = () =>
      longAnalysis({
        baseUrl: BASE,
        email: "e",
        password: "p",
        document: "text",
        fetchImpl: impl,
        now,
      });
    return { run, calls };
  }

  it("passes a 200 that took at least 50 s", async () => {
    const { run, calls } = scenario(() => json(200, { analysis: {} }), 51_000);
    expect(await run()).toMatchObject({ verdict: "pass", status: 200, seconds: 51 });
    expect(calls).toContain("DELETE /api/v1/documents/doc-1");
  });

  it("calls a fast 200 inconclusive, not a pass: the chain was never stretched", async () => {
    const { run } = scenario(() => json(200, { analysis: {} }), 12_000);
    expect(await run()).toMatchObject({ verdict: "inconclusive", seconds: 12 });
  });

  it("fails on a proxy's 504, and says the proxy timeout is the suspect", async () => {
    const { run, calls } = scenario(() => json(504), 30_000);
    const result = await run();
    expect(result).toMatchObject({ verdict: "fail", status: 504 });
    expect(result.reason).toMatch(/proxy.*below the server's 120 s/);
    expect(calls).toContain("DELETE /api/v1/documents/doc-1");
  });

  it("tells a 502 (the instance went away) from a 504 (the proxy gave up)", async () => {
    const { run } = scenario(() => json(502), 20_800);
    const result = await run();
    expect(result).toMatchObject({ verdict: "fail", status: 502 });
    expect(result.reason).toMatch(
      /instance serving the request went away.*stop grace period/,
    );
    expect(result.reason).not.toMatch(/timeout is below/);
  });

  it("fails on a connection closed mid-request, and says so rather than blaming the API", async () => {
    const { run, calls } = scenario(() => {
      throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
    }, 30_000);
    const result = await run();
    expect(result).toMatchObject({ verdict: "fail", status: null });
    expect(result.reason).toMatch(
      /closed after 30\.0 s \(UND_ERR_SOCKET\).*cut the request/,
    );
    expect(calls).toContain("DELETE /api/v1/documents/doc-1");
  });

  it("fails on an application error even when it was slow", async () => {
    const { run } = scenario(() => json(500), 70_000);
    expect(await run()).toMatchObject({ verdict: "fail", status: 500 });
  });

  it("sends the session cookie's name=value only, never its attributes", async () => {
    /** @type {string | null} */
    let cookie = null;
    const { impl } = fakeFetch({
      "POST /api/v1/auth/login": () =>
        json(200, {}, { "Set-Cookie": "cc_session=abc; HttpOnly; Secure" }),
      "POST /api/v1/documents": () => json(201, { document: { id: "doc-1" } }),
      "POST /api/v1/documents/doc-1/analyze": (init) => {
        cookie = new Headers(init?.headers).get("Cookie");
        return json(200);
      },
      "DELETE /api/v1/documents/doc-1": () => new Response(null, { status: 204 }),
    });
    await longAnalysis({
      baseUrl: BASE,
      email: "e",
      password: "p",
      document: "t",
      fetchImpl: impl,
    });
    expect(cookie).toBe("cc_session=abc");
  });

  it("fails before analysing when the upload is refused", async () => {
    const { impl, calls } = fakeFetch({
      "POST /api/v1/auth/login": () => json(200, {}, { "Set-Cookie": "cc_session=abc" }),
      "POST /api/v1/documents": () => json(422),
    });
    const result = await longAnalysis({
      baseUrl: BASE,
      email: "e",
      password: "p",
      document: "t",
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ verdict: "fail", status: 422 });
    expect(calls).not.toContain("POST /api/v1/documents/doc-1/analyze");
  });
});

describe("errorRatio — api_5xx_rate's ratio from Prometheus", () => {
  it("reads the instant value", async () => {
    const { impl } = fakeFetch({
      "GET /api/v1/query": () =>
        json(200, { data: { result: [{ value: [0, "0.031"] }] } }),
    });
    expect(
      await errorRatio({ prometheusUrl: "https://prom.test", fetchImpl: impl }),
    ).toBeCloseTo(0.031);
  });

  it("is null with no traffic (no series, or 0/0)", async () => {
    for (const body of [
      { data: { result: [] } },
      { data: { result: [{ value: [0, "NaN"] }] } },
    ]) {
      const { impl } = fakeFetch({ "GET /api/v1/query": () => json(200, body) });
      expect(
        await errorRatio({ prometheusUrl: "https://prom.test", fetchImpl: impl }),
      ).toBeNull();
    }
  });

  it("throws on a Prometheus error rather than reporting zero", async () => {
    const { impl } = fakeFetch({ "GET /api/v1/query": () => json(401) });
    await expect(
      errorRatio({ prometheusUrl: "https://prom.test", fetchImpl: impl }),
    ).rejects.toThrow(/401/);
  });
});

describe("watch — SRS §8's 15 minutes", () => {
  const quiet = { sleepImpl: async () => {}, log: () => {} };
  /** @param {boolean[]} outcomes */
  const probes = (outcomes) => {
    let i = 0;
    return async () => ({ ok: outcomes[i++] ?? true, lines: [] });
  };

  it("runs one round per interval for the whole window", async () => {
    let rounds = 0;
    const result = await watch({
      probe: async () => ((rounds += 1), { ok: true, lines: [] }),
      minutes: 15,
      intervalMs: 60_000,
      ...quiet,
    });
    expect(result.ok).toBe(true);
    expect(rounds).toBe(15);
  });

  it("tolerates one failed probe as a blip", async () => {
    const result = await watch({
      probe: probes([true, false, true]),
      minutes: 3,
      intervalMs: 60_000,
      ...quiet,
    });
    expect(result).toMatchObject({ ok: true, failedProbes: 1 });
  });

  it("fails on the second failed probe, without waiting out the window", async () => {
    let rounds = 0;
    const probe = probes([false, true, false, true, true]);
    const result = await watch({
      probe: async () => ((rounds += 1), probe()),
      minutes: 5,
      intervalMs: 60_000,
      ...quiet,
    });
    expect(result).toMatchObject({ ok: false, failedProbes: 2 });
    expect(rounds).toBe(3);
  });

  it("fails at once on a 5xx ratio above api_5xx_rate's threshold", async () => {
    const ratios = [0.001, ERROR_RATIO_THRESHOLD + 0.001];
    let i = 0;
    const result = await watch({
      probe: probes([]),
      ratio: async () => ratios[i++] ?? 0,
      minutes: 15,
      intervalMs: 60_000,
      ...quiet,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/above api_5xx_rate/);
  });

  it("does not fail on a ratio exactly at the threshold, or on no data", async () => {
    const ratios = [ERROR_RATIO_THRESHOLD, null];
    let i = 0;
    const result = await watch({
      probe: probes([]),
      ratio: async () => ratios[i++] ?? null,
      minutes: 2,
      intervalMs: 60_000,
      ...quiet,
    });
    expect(result).toMatchObject({ ok: true, worstRatio: ERROR_RATIO_THRESHOLD });
  });

  it("does not let an unreachable Prometheus pass or fail the watch on its own", async () => {
    const result = await watch({
      probe: probes([]),
      ratio: async () => {
        throw new Error("down");
      },
      minutes: 2,
      intervalMs: 60_000,
      ...quiet,
    });
    expect(result).toMatchObject({ ok: true, worstRatio: null });
  });
});
