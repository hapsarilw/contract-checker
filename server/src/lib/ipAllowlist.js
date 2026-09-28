import { BlockList, isIP } from "node:net";

/**
 * A comma-separated list of IPs and CIDR ranges, as node's BlockList (which
 * matches both address families correctly, so no hand-rolled prefix maths).
 * Used for SYNTHETIC_CHECK_IPS (step 67). Pure and dependency-free so that
 * config.js can validate the list at boot with the same parser the limiter
 * uses at request time: a typo in the allowlist fails the deploy instead of
 * quietly letting no checker through.
 *
 * @param {string} spec e.g. "203.0.113.7, 198.51.100.0/24, 2001:db8::/32"
 * @returns {BlockList}
 * @throws {Error} naming the first entry that is not an address or a range
 */
export function parseIpAllowlist(spec) {
  const list = new BlockList();
  for (const raw of spec.split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const [address, prefixText, extra] = entry.split("/");
    const family = isIP(address);
    if (family === 0 || extra !== undefined) throw new Error(`not an IP or CIDR range: "${entry}"`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefixText === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = Number(prefixText);
    const max = family === 4 ? 32 : 128;
    if (!/^\d+$/.test(prefixText) || prefix > max) {
      throw new Error(`not a valid prefix length in "${entry}"`);
    }
    list.addSubnet(address, prefix, type);
  }
  return list;
}

/**
 * Whether `ip` is on the list. Express reports an IPv4 client on a
 * dual-stack socket as IPv4-mapped IPv6 ("::ffff:203.0.113.7"); BlockList
 * matches those against IPv4 entries itself (checked, and pinned by
 * tests/unit/ipAllowlist.test.js), so no unwrapping happens here.
 *
 * @param {BlockList} list
 * @param {string | undefined} ip
 */
export function isAllowlisted(list, ip) {
  if (!ip) return false;
  const family = isIP(ip);
  if (family === 0) return false;
  return list.check(ip, family === 4 ? "ipv4" : "ipv6");
}
