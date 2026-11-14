/** URL classification shared by manual, x-feed and instagram-profile (so each source claims only its own links). */

const X_HOSTS = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i;
const IG_HOSTS = /^(?:www\.)?(?:instagram\.com|instagr\.am)$/i;

const parse = (raw: string): URL | undefined => {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
};

export const isXHost = (raw: string): boolean => !!parse(raw) && X_HOSTS.test(parse(raw)!.hostname);
export const isInstagramHost = (raw: string): boolean => !!parse(raw) && IG_HOSTS.test(parse(raw)!.hostname);

/** `https://x.com/user/status/123` (also twitter.com, mobile.) -> { handle, id }. */
export function parseXStatusUrl(raw: string): { handle: string; id: string } | undefined {
  const u = parse(raw);
  if (!u || !X_HOSTS.test(u.hostname)) return undefined;
  const m = /^\/(?:i\/web\/)?([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/.exec(u.pathname);
  return m ? { handle: m[1]!, id: m[2]! } : undefined;
}

export interface InstagramPostRef {
  kind: "post" | "reel";
  code: string;
  /** Present when the URL carries it (`/handle/p/CODE/`). */
  handle?: string;
  /** Canonical page URL rebuilt from validated pieces (no query, no fragment). */
  url: string;
}

const USER = "[A-Za-z0-9_][A-Za-z0-9._]{0,29}";
const CODE = "[A-Za-z0-9_-]{5,32}";
const IG_MEDIA = new RegExp(`^/(?:(${USER})/)?(p|reel|reels|tv)/(${CODE})/?$`);

/** Instagram post/reel/tv URL -> reference; profile, stories and anything else -> undefined. */
export function parseInstagramPostUrl(raw: string): InstagramPostRef | undefined {
  const u = parse(raw);
  if (!u || !IG_HOSTS.test(u.hostname) || u.username || u.password || u.port) return undefined;
  const m = IG_MEDIA.exec(u.pathname);
  if (!m) return undefined;
  const type = m[2]!;
  const kind = type.startsWith("reel") ? "reel" : "post";
  const seg = type === "p" || type === "tv" ? type : "reel";
  return { kind, code: m[3]!, handle: m[1], url: `https://www.instagram.com/${seg}/${m[3]}/` };
}
