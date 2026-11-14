import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Resolves a hostname to every address it points to. */
export type Lookup = (host: string) => Promise<string[]>;
export const systemLookup: Lookup = async (h) => (await dnsLookup(h, { all: true })).map((a) => a.address);

function v4Private(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function expandV6(ip: string): number[] | undefined {
  let s = ip.toLowerCase().split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const o = dotted[1]!.split(".").map(Number);
    s = s.slice(0, -dotted[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array(Math.max(fill, 0)).fill("0"), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : undefined;
}

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses (IPv4, IPv6 and IPv4-embedded IPv6). */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind !== 6) return true; // not an address: refuse
  const g = expandV6(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    // ::ffff:a.b.c.d, ::a.b.c.d (and ::, ::1)
    if (g[5] === 0 && g[6] === 0 && g[7]! <= 1) return true;
    return v4Private(v4(g[6]!, g[7]!));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Private(v4(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return v4Private(v4(g[1]!, g[2]!)); // 6to4
  return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00;
}

/** Every address of the host must be public (a name that resolves to nothing is refused). */
export async function resolvesPublic(host: string, lookup: Lookup): Promise<boolean> {
  try {
    const addrs = await lookup(host.replace(/^\[|\]$/g, ""));
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a));
  } catch {
    return false;
  }
}

/** Reads at most `max` bytes; returns undefined when the body is larger (the stream is cancelled). */
export async function readCapped(res: Response, max: number): Promise<Buffer | undefined> {
  if (!res.body) {
    const b = Buffer.from(await res.arrayBuffer());
    return b.length > max ? undefined : b;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
