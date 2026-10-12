/**
 * Egress guard (spec SEC-4).
 *
 * A non-admin caller must not be able to make the gateway connect to the
 * operator's internal network: not through a backend target, and not through
 * a URL in plugin configuration. Addresses in loopback, link-local (which
 * includes cloud metadata endpoints), private and other non-public ranges are
 * refused unless an allow-list covers them.
 *
 * The admin checks on write. Nodes check again at connect time, so a DNS
 * record that changes afterwards cannot bypass the rule.
 */

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96],
] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv6");

/** Parses a comma-separated CIDR list into a block list. Throws on a malformed entry. */
export function parseCidrList(value: string, name: string): BlockList {
  const list = new BlockList();
  for (const raw of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [addr, prefix] = raw.split("/");
    const family = isIP(addr ?? "");
    if (!family) throw new Error(`${name}: '${raw}' is not a CIDR`);
    const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix);
    if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) throw new Error(`${name}: '${raw}' is not a CIDR`);
    list.addSubnet(addr!, bits, family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

/** True when `ip` is in a range the public internet cannot route to. */
export function isNonPublic(ip: string): boolean {
  const family = isIP(ip);
  if (!family) return true; // not an address at all: refuse
  // An IPv4-mapped IPv6 address is judged as the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return NON_PUBLIC.check(mapped[1]!, "ipv4");
  return NON_PUBLIC.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** Resolves a host to addresses. Injected in tests. */
export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

/**
 * Decides whether a non-admin caller may point the gateway at `host`.
 * Returns `null` when allowed, or the reason when not.
 */
export async function egressViolation(host: string, allow: BlockList, resolve: Resolver = systemResolver): Promise<string | null> {
  const bare = host.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(bare)) {
    addresses = [bare];
  } else {
    try {
      addresses = await resolve(bare);
    } catch {
      return `'${host}' does not resolve`;
    }
    if (addresses.length === 0) return `'${host}' does not resolve`;
  }
  for (const ip of addresses) {
    if (!isNonPublic(ip)) continue;
    const family = isIP(ip) === 4 ? "ipv4" : "ipv6";
    if (!allow.check(ip, family)) return `'${host}' resolves to ${ip}, which is not a public address`;
  }
  return null;
}
