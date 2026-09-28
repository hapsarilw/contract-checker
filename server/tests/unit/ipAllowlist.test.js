import { describe, expect, it } from "vitest";
import { isAllowlisted, parseIpAllowlist } from "../../src/lib/ipAllowlist.js";

describe("parseIpAllowlist / isAllowlisted (SYNTHETIC_CHECK_IPS)", () => {
  const list = parseIpAllowlist(" 203.0.113.7, 198.51.100.0/24 ,2001:db8::/32");

  it.each([
    ["203.0.113.7", true],
    ["203.0.113.8", false],
    ["198.51.100.1", true],
    ["198.51.100.255", true],
    ["198.51.101.1", false],
    ["2001:db8::1", true],
    ["2001:db9::1", false],
    // Express reports an IPv4 client on a dual-stack socket like this.
    ["::ffff:198.51.100.9", true],
    ["::ffff:10.0.0.1", false],
    ["", false],
    ["not-an-ip", false],
    [undefined, false],
  ])("%s -> %s", (ip, expected) => {
    expect(isAllowlisted(list, ip)).toBe(expected);
  });

  it.each(["example.com", "10.0.0.0/33", "10.0.0.0/x", "1.2.3.4/8/9", "::1/129"])(
    "rejects %s at parse time, so a typo fails boot instead of admitting nobody",
    (entry) => {
      expect(() => parseIpAllowlist(entry)).toThrow();
    },
  );
});
