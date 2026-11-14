import { type Logger, type Media, type RawItem, type Source, type SourceConfig, type SourceContext } from "@auto-curator/contracts";
import { z } from "zod";
import { BrowserError, openBrowser, type BrowserSession, type PageReader } from "./browser/cdp.js";
import type { SourceDeps } from "./types.js";
import { parseXStatusUrl } from "./urls.js";
import { parseCount, parseOptions } from "./util.js";

/** A post as read from the page. */
export interface XPost {
  id: string;
  url: string;
  /** Handle without @. */
  author: string;
  text: string;
  postedAt: string | null;
  likes: number;
  isRepost: boolean;
  isReply: boolean;
  isPinned: boolean;
  /** Paid ad in the feed. */
  promoted: boolean;
  images: string[];
  hasVideo: boolean;
}

/** Raw card data from the page script. Kept plain so the parser is testable without a browser. */
export interface RawArticle {
  href: string;
  userName: string;
  text: string;
  time: string;
  context: string;
  likes: string;
  replyingTo: boolean;
  promoted: boolean;
  images: string[];
  video: boolean;
}
export interface XSnapshot {
  finalUrl: string;
  bodyTextStart: string;
  articles: RawArticle[];
}

/** A plain string on purpose: functions get "__name" helpers injected by tsx/esbuild that do not exist inside the page. */
export const X_SNAPSHOT_SCRIPT = `(() => {
  const txt = (el) => ((el && (el.innerText || el.textContent)) || "").trim();
  const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].map((art) => {
    const timeEl = art.querySelector("time");
    const link = timeEl ? timeEl.closest("a") : art.querySelector('a[href*="/status/"]');
    return {
      href: link ? link.getAttribute("href") || "" : "",
      userName: txt(art.querySelector('[data-testid="User-Name"]')),
      text: txt(art.querySelector('[data-testid="tweetText"]')),
      time: timeEl ? timeEl.getAttribute("datetime") || "" : "",
      context: txt(art.querySelector('[data-testid="socialContext"]')),
      likes: txt(art.querySelector('[data-testid="like"], [data-testid="unlike"]')),
      replyingTo: /^(replying to|em resposta a)/i.test(txt(art.querySelector('div[dir="ltr"] > span'))) || /(replying to|em resposta a)\\s+@/i.test(txt(art).slice(0, 200)),
      promoted: /(?:^|\\n)(ad|an[uú]ncio|promovido|promoted)\\s*$/i.test(txt(art)),
      images: [...art.querySelectorAll('[data-testid="tweetPhoto"] img')].map((i) => i.getAttribute("src") || "").filter(Boolean),
      video: !!art.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"]'),
    };
  });
  return {
    finalUrl: location.href,
    bodyTextStart: ((document.body && document.body.innerText) || "").slice(0, 600),
    articles: articles.slice(0, 60),
  };
})()`;

export const X_READY_SELECTOR = 'article[data-testid="tweet"]';

const LOGIN_RE = /\/i\/flow\/login|\/login\b|\/account\/access/i;
const THROTTLE_RE = /(rate limit|something went wrong|algo deu errado|try again later|tente novamente mais tarde|verify to continue|confirm you('| a)re human)/i;
const PINNED_RE = /(pinned|fixado)/i;
const REPOST_RE = /(reposted|repostou|retweeted|retweetou)/i;

/** Upgrades a pbs.twimg.com media URL to the large rendition. Returns undefined for any other host. */
export function largeImageUrl(src: string): string | undefined {
  try {
    const u = new URL(src);
    if (u.protocol !== "https:" || u.hostname !== "pbs.twimg.com" || !u.pathname.startsWith("/media/")) return undefined;
    u.searchParams.set("name", "large");
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Cards -> posts. Drops cards without a status link and duplicates; the author comes from the link (`/user/status/id`). */
export function parseArticles(snap: Pick<XSnapshot, "articles">): XPost[] {
  const out: XPost[] = [];
  for (const a of snap.articles) {
    const path = (() => {
      try {
        return /^https?:/i.test(a.href) ? new URL(a.href).pathname : a.href.split(/[?#]/)[0]!;
      } catch {
        return "";
      }
    })();
    const m = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec(path);
    if (!m) continue;
    const id = m[2]!;
    if (out.some((o) => o.id === id)) continue;
    out.push({
      id,
      url: `https://x.com/${m[1]}/status/${id}`,
      author: m[1]!,
      text: a.text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
      postedAt: a.time && !Number.isNaN(Date.parse(a.time)) ? new Date(a.time).toISOString() : null,
      likes: parseCount(a.likes),
      isRepost: REPOST_RE.test(a.context),
      isReply: a.replyingTo || /^\s*@\w/.test(a.text),
      isPinned: PINNED_RE.test(a.context),
      promoted: a.promoted,
      images: a.images.map(largeImageUrl).filter((u): u is string => !!u),
      hasVideo: a.video,
    });
  }
  return out;
}

export function xBlockReason(snap: XSnapshot): "login" | "throttled" | undefined {
  if (LOGIN_RE.test(snap.finalUrl)) return "login";
  if (!snap.articles.length && THROTTLE_RE.test(snap.bodyTextStart)) return "throttled";
  return undefined;
}

/** Text length ignoring links and whitespace (a post that is only a link has no substance). */
export const contentLength = (t: string): number => t.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().length;

export interface XFilters {
  ownHandle?: string;
  includeReplies: boolean;
  minChars: number;
  minLikes: number;
}

/** Why a feed post is not worth ingesting (undefined = ok). Free, no LLM. */
export function xPrefilter(p: XPost, f: XFilters): string | undefined {
  if (p.promoted) return "anúncio";
  if (f.ownHandle && p.author.toLowerCase() === f.ownHandle.replace(/^@/, "").toLowerCase()) return "post próprio";
  if (p.isReply && !f.includeReplies) return "resposta";
  if (contentLength(p.text) < f.minChars) return `curto (<${f.minChars} caracteres)`;
  if (p.likes < f.minLikes) return `poucas curtidas (<${f.minLikes})`;
  return undefined;
}

export function xMedia(p: Pick<XPost, "images" | "hasVideo">): Media[] {
  const media: Media[] = p.images.map((url) => ({ type: "image", url }));
  if (p.hasVideo) media.push({ type: "video" });
  return media;
}

export function xPostToRaw(p: XPost, o: { origin: "feed" | "manual"; source: string; extra?: Record<string, unknown> }): RawItem {
  return {
    dedupeKey: `x:${p.id}`,
    origin: o.origin,
    source: o.source,
    sourceUrl: p.url,
    author: p.author,
    text: p.text,
    media: xMedia(p),
    postedAt: p.postedAt ?? undefined,
    engagement: { likes: p.likes },
    extra: { isRepost: p.isRepost, hasVideo: p.hasVideo, ...o.extra },
  };
}

const Shape = {
  feed: z.enum(["following", "for_you"]),
  ownHandle: z.string().optional(),
  includeReplies: z.boolean().default(false),
  minChars: z.number().int().nonnegative().default(120),
  minLikes: z.number().int().nonnegative().default(0),
  maxPerScan: z.number().int().min(1).max(100).default(15),
  limits: z
    .object({
      minDelaySeconds: z.number().nonnegative().default(20),
      maxPerHour: z.number().int().positive().default(20),
      cooldownMinutes: z.number().nonnegative().default(60),
    })
    .strict()
    .default({}),
};

export type XFeedOptions = ReturnType<typeof parseXOptions>;
const parseXOptions = (cfg: SourceConfig) => parseOptions("x-feed", Shape, cfg);

export class XFeedSource implements Source {
  readonly type = "x-feed";
  readonly name: string;

  constructor(private readonly o: XFeedOptions, private readonly deps: { logger: Logger; fetch?: typeof fetch; pageReader?: PageReader; sleep?: (ms: number) => Promise<void> }) {
    this.name = o.name ?? "x-feed";
  }

  private session(ctx: SourceContext): BrowserSession {
    return openBrowser(ctx, { limits: this.o.limits, stateKey: "x.limiter", reader: this.deps.pageReader, fetch: this.deps.fetch, sleep: this.deps.sleep });
  }

  /** One rate-limited read of an X page. Login walls and throttling become BrowserErrors (and trip the limiter). */
  private async snapshot(s: BrowserSession, url: string, scrolls: number, clickTab?: RegExp): Promise<XSnapshot> {
    if (!(await s.isAvailable())) throw new BrowserError("O Chrome dedicado não está aberto. Rode scripts/chrome-reader.sh e entre com a conta secundária do X.", "NOT_AVAILABLE");
    const snap = await s.read<XSnapshot>({ url, script: X_SNAPSHOT_SCRIPT, readySelector: X_READY_SELECTOR, clickTab, scrolls });
    const reason = xBlockReason(snap);
    if (reason === "login") throw new BrowserError("O X pediu login no Chrome dedicado: abra-o e entre com a conta secundária.", "AUTH_REQUIRED");
    if (reason === "throttled") {
      s.limiter.trip();
      throw new BrowserError("O X pediu para reduzir o ritmo ou mostrou um desafio; vou esperar antes de tentar de novo.", "RATE_LIMITED");
    }
    return snap;
  }

  async fetch(ctx: SourceContext): Promise<RawItem[]> {
    const listLimit = Math.min(60, this.o.maxPerScan * 3);
    const tab = this.o.feed === "following" ? /^(following|seguindo)$/i : /^(for you|para voc[eê])$/i;
    const snap = await this.snapshot(this.session(ctx), "https://x.com/home", Math.min(8, Math.max(1, Math.ceil(listLimit / 6))), tab);
    const posts = parseArticles(snap).slice(0, listLimit);
    const kept: XPost[] = [];
    for (const p of posts) {
      const why = xPrefilter(p, this.o);
      if (why) this.deps.logger.debug(`${this.name}: ${p.url} ignorado (${why})`);
      else kept.push(p);
    }
    // best engagement first; the cap bounds what the engine (and its LLM) sees per scan
    kept.sort((a, b) => b.likes - a.likes);
    this.deps.logger.info(`${this.name}: ${posts.length} lidos, ${kept.length} passaram nos filtros`);
    return kept.slice(0, this.o.maxPerScan).map((p) => xPostToRaw(p, { origin: "feed", source: this.name, extra: { feed: this.o.feed } }));
  }

  /** x.com / twitter.com status URL -> that post (plus the author's own continuation of the thread). */
  async fromInput(input: string, ctx: SourceContext): Promise<RawItem | undefined> {
    const first = input.trim().split(/\s+/)[0] ?? "";
    const ref = parseXStatusUrl(first);
    if (!ref) return undefined;
    const post = await this.readPost(this.session(ctx), ref);
    if (!post || !post.text.trim()) throw new BrowserError("Não consegui ler esse post do X (apagado, privado ou o layout mudou).", "NOT_FOUND");
    return xPostToRaw(post, { origin: "manual", source: this.name });
  }

  async readPost(s: BrowserSession, ref: { handle: string; id: string }): Promise<XPost | undefined> {
    const snap = await this.snapshot(s, `https://x.com/${ref.handle}/status/${ref.id}`, 1);
    const posts = parseArticles(snap);
    const first = posts.find((p) => p.id === ref.id);
    if (!first) return undefined;
    // a thread: the author's own consecutive posts right after the first one
    const cont: XPost[] = [];
    for (const p of posts.slice(posts.indexOf(first) + 1)) {
      if (p.author.toLowerCase() !== first.author.toLowerCase()) break;
      cont.push(p);
    }
    if (!cont.length) return first;
    const all = [first, ...cont];
    return { ...first, text: all.map((p) => p.text).join("\n\n"), images: all.flatMap((p) => p.images).slice(0, 4), hasVideo: all.some((p) => p.hasVideo) };
  }
}

export function createXFeedSource(cfg: SourceConfig, deps: SourceDeps): Source {
  return new XFeedSource(parseXOptions(cfg), deps);
}

