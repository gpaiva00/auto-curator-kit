import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicUrl } from "./util.js";

/** Resolves a hostname to every address it points to. */
export type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (h) => (await dnsLookup(h, { all: true })).map((a) => a.address);

const MAX_REDIRECTS = 5;

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

/** Reads at most `max` bytes of the body and cancels the rest of the stream. */
export async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.byteLength;
    if (total >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, max);
}

export interface SafeGetOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  allowHttp?: boolean;
  /**
   * DNS resolver used to refuse hosts that point to private addresses. Default: the system resolver, but only when
   * `f` is the real global fetch (injected fakes never touch the network). `null` disables the check.
   */
  lookup?: Lookup | null;
}

/**
 * GET of a public URL. Redirects are followed by hand (max 5) and every hop is re-validated: public https host
 * whose DNS answers are all public. The body is streamed with a byte cap. Returns undefined when any hop is refused.
 * (Residual risk: the connection resolves the name again, so a rebinding race is narrowed, not eliminated.)
 */
export async function safeGet(url: string, f: typeof fetch, o: SafeGetOptions): Promise<{ res: Response; finalUrl: string; body: Buffer } | undefined> {
  const lookup = o.lookup === undefined ? (f === globalThis.fetch ? systemLookup : undefined) : (o.lookup ?? undefined);
  const signal = AbortSignal.timeout(o.timeoutMs);
  let cur = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isPublicUrl(cur, { allowHttp: o.allowHttp })) return undefined;
    if (lookup && !(await resolvesPublic(new URL(cur).hostname, lookup))) return undefined;
    const res = await f(cur, { headers: o.headers, signal, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (loc) {
      await res.body?.cancel().catch(() => {});
      cur = new URL(loc, cur).toString();
      continue;
    }
    const finalUrl = res.url || cur;
    if (!isPublicUrl(finalUrl, { allowHttp: o.allowHttp })) return undefined;
    return { res, finalUrl, body: res.ok ? await readCapped(res, o.maxBytes) : Buffer.alloc(0) };
  }
  return undefined;
}
