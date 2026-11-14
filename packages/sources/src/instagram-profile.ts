import { type Logger, type RawItem, type Source, type SourceConfig, type SourceContext, errMsg } from "@auto-curator/contracts";
import { z } from "zod";
import { BrowserError, isStopError, openBrowser, type BrowserSession, type PageReader } from "./browser/cdp.js";
import { metaTags, pageTitle } from "./html.js";
import type { SourceDeps } from "./types.js";
import { parseInstagramPostUrl, type InstagramPostRef } from "./urls.js";
import { clip, parseOptions } from "./util.js";

/** What we pull out of a post page. Kept plain so parsing is testable without a browser. */
export interface PageSnapshot {
  finalUrl: string;
  title: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  /**
   * The picture the post page really shows (largest non-avatar <img> inside <article>). og:image is a 640x640
   * CENTER-CROP of the media, which cuts the sides of 4:5 posts and the text of screenshots.
   */
  mediaImage?: string;
  ogVideo?: string;
  /** Visible text of the main post area (may be empty). */
  captionText?: string;
  /** First profile link in the post header (last-resort author; collab posts list the partner first). */
  headerHandle?: string;
  bodyTextStart: string;
  /** True when the page has a <video> element (reels stream through blob: URLs, so og:video is empty). */
  hasVideoEl?: boolean;
  /** Player controls are on the post: the <video> can mount late, so this catches what hasVideoEl misses. */
  hasVideoControls?: boolean;
}

/** What we pull out of a profile page: every link on it (filtered later, in plain code). */
export interface ProfileSnapshot {
  finalUrl: string;
  hrefs: string[];
  bodyTextStart: string;
}

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * "7 de novembro de 2026" / "November 7, 2026" -> ISO at 12:00 Brasilia (15:00Z). Instagram only gives the day.
 * Without a year the current year is assumed (the previous one if that would be in the future).
 */
export function parsePostedAt(raw: string | undefined, now: Date = new Date()): string | undefined {
  const t = raw?.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (!t) return undefined;
  let day: number | undefined;
  let mon: number | undefined;
  let year: number | undefined;
  let m = /(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?/.exec(t);
  if (m) {
    day = Number(m[1]);
    mon = MONTHS[m[2]!];
    year = m[3] ? Number(m[3]) : undefined;
  } else if ((m = /([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/.exec(t))) {
    mon = MONTHS[m[1]!];
    day = Number(m[2]);
    year = m[3] ? Number(m[3]) : undefined;
  }
  if (!mon || !day || day < 1 || day > 31) return undefined;
  let y = year ?? now.getUTCFullYear();
  let d = new Date(Date.UTC(y, mon - 1, day, 15));
  if (!year && d.getTime() > now.getTime() + 86_400_000) d = new Date(Date.UTC(--y, mon - 1, day, 15));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const IG_POST_HREF = /^(?:\/([A-Za-z0-9._]+))?\/(p|reel)\/([A-Za-z0-9_-]{5,20})\/?$/;

/**
 * Post URLs of `handle` from the raw links on its profile page, in page order (newest first), de-duplicated.
 * Links to other accounts (suggestions, collabs, tagged posts) are dropped.
 */
export function extractProfileLinks(handle: string, hrefs: string[], limit = 12): string[] {
  const want = handle.replace(/^@/, "").toLowerCase();
  const out: string[] = [];
  for (const raw of hrefs) {
    let path = raw;
    if (/^https?:\/\//i.test(raw)) {
      try {
        path = new URL(raw).pathname;
      } catch {
        continue;
      }
    }
    const m = IG_POST_HREF.exec(path.split(/[?#]/)[0]!);
    if (!m || (m[1] && m[1].toLowerCase() !== want)) continue;
    const url = `https://www.instagram.com/${m[2]}/${m[3]}/`;
    if (!out.includes(url)) out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

const THROTTLED_RE = /(tente novamente mais tarde|try again later|too many requests|captcha|verifique que|verify to continue|something went wrong|algo deu errado)/i;
const LOGIN_RE = /\/accounts\/login|\/accounts\/emailsignup|\/challenge\//i;
const WALL_TEXT_RE = /(entrar|log ?in|faça login|confirm(e|ar) (sua )?idade|confirm your age|verify your age|date of birth|data de nascimento)/i;

export function isLoginWall(s: Pick<PageSnapshot, "finalUrl" | "ogDescription" | "captionText" | "bodyTextStart">): boolean {
  if (LOGIN_RE.test(s.finalUrl)) return true;
  // a real post always has an og:description or a caption; the wall has neither
  return !s.ogDescription && !s.captionText && WALL_TEXT_RE.test(s.bodyTextStart);
}

export interface ParsedPost {
  handle?: string;
  displayName?: string;
  caption?: string;
  title?: string;
  imageUrl?: string;
  hasVideo: boolean;
  postedAt?: string;
  likes?: number;
  comments?: number;
}

/** Words Instagram puts between the handle and the date; the locale of the text and of the date can differ. */
const ON = "(?:em|on|no|na|el|le)";
const stripQuotes = (t: string) => t.replace(/^[\s"“”'«]+|[\s"“”'»]+$/g, "").trim();

/** "1.234" / "1,234" / "1,2 mil" style counts from the og:description prefix. */
function countFrom(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /([\d.,]+)\s*(mil|k|mi|m)?/i.exec(raw.trim());
  if (!m) return undefined;
  const unit = (m[2] ?? "").toLowerCase();
  let num = m[1]!;
  if (!unit) num = num.replace(/[.,]/g, "");
  else num = num.replace(",", ".");
  const n = parseFloat(num);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(unit === "mil" || unit === "k" ? n * 1_000 : unit === "mi" || unit === "m" ? n * 1_000_000 : n);
}

/**
 * og:description looks like (pt-BR) `1.234 curtidas, 56 comentários - handle em 7 de novembro de 2026: "Legenda"`
 * and (en) `1,234 likes, 56 comments - handle on November 7, 2026: "Caption"`. Both are handled; anything else
 * falls back to the visible caption or the whole description.
 */
export function parsePost(snap: PageSnapshot, now: Date = new Date()): ParsedPost {
  const desc = snap.ogDescription?.trim() ?? "";
  const heading = snap.ogTitle ?? snap.title;
  const isVideo = !!snap.ogVideo || !!snap.hasVideoEl || !!snap.hasVideoControls;
  let handle: string | undefined;
  let caption: string | undefined;
  let dateText: string | undefined;

  const m = new RegExp(`^([^-–]*?)[-–]\\s*@?([A-Za-z0-9._]{1,30})\\s+${ON}\\s+([^:]{3,40}):\\s*([\\s\\S]*)$`).exec(desc);
  let likes: number | undefined;
  let comments: number | undefined;
  if (m) {
    handle = m[2];
    dateText = m[3];
    caption = stripQuotes(m[4]!);
    likes = countFrom(/([\d.,]+\s*(?:mil|k|mi|m)?)\s*(?:curtidas?|likes?)/i.exec(m[1]!)?.[1]);
    comments = countFrom(/([\d.,]+\s*(?:mil|k|mi|m)?)\s*(?:coment[aá]rios?|comments?)/i.exec(m[1]!)?.[1]);
  }
  if (!handle) {
    const t = /\(@([A-Za-z0-9._]{1,30})\)/.exec(heading) ?? /^([A-Za-z0-9._]{1,30}) (?:on|no) Instagram/i.exec(heading);
    handle = t?.[1] ?? (snap.headerHandle && /^[A-Za-z0-9._]{1,30}$/.test(snap.headerHandle) ? snap.headerHandle : undefined);
  }
  if (!caption) {
    const t = /(?:on|no) Instagram:\s*([\s\S]+)$/i.exec(heading);
    caption = (snap.captionText?.trim() || (t ? stripQuotes(t[1]!) : "") || stripQuotes(desc)) || undefined;
  }
  // display name: "Ana Souza (@anasouza) • ..." or, without the handle, "Xuxa Nave no Instagram: ..."
  const name = (/^(.{1,80}?)\s*\(@/.exec(heading) ?? /^(.{1,80}?)\s+(?:on|no)\s+Instagram\b/i.exec(heading))?.[1]?.trim();
  return {
    handle,
    displayName: clip(name ?? handle, 100),
    caption: clip(caption, 5000),
    title: clip(heading, 300),
    // a video post keeps og:image (its cover); for photos prefer the real, uncropped picture
    imageUrl: isVideo ? snap.ogImage : (snap.mediaImage ?? snap.ogImage),
    hasVideo: isVideo,
    postedAt: parsePostedAt(dateText, now),
    likes,
    comments,
  };
}

/** Builds a PageSnapshot from saved HTML (og: tags only; no layout-dependent fields). Used by tests and offline checks. */
export function snapshotFromHtml(html: string, finalUrl: string): PageSnapshot {
  const m = metaTags(html);
  return {
    finalUrl,
    title: pageTitle(html) ?? "",
    ogTitle: m["og:title"],
    ogDescription: m["og:description"],
    ogImage: m["og:image"],
    ogVideo: m["og:video"] ?? m["og:video:url"],
    bodyTextStart: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 600),
  };
}

const PAGE_SCRIPT = `(() => {
  const meta = (p) => { const e = document.querySelector('meta[property="' + p + '"]'); return (e && e.content) || undefined; };
  const art = document.querySelector("article") || document.querySelector("main");
  const h1 = art && art.querySelector("h1");
  return {
    finalUrl: location.href,
    title: document.title,
    ogTitle: meta("og:title"),
    ogDescription: meta("og:description"),
    ogImage: meta("og:image"),
    ogVideo: meta("og:video") || meta("og:video:url"),
    mediaImage: (() => {
      const root = document.querySelector("article") || document.querySelector("main");
      if (!root) return undefined;
      const c = [...root.querySelectorAll("img")]
        .filter((i) => !/^(foto do perfil|profile picture)/i.test(i.alt || "") && i.naturalWidth >= 300)
        .map((i) => ({ src: i.currentSrc || i.src, area: i.getBoundingClientRect().width * i.getBoundingClientRect().height }))
        .filter((x) => x.src && x.area > 40000)
        .sort((a, b) => b.area - a.area);
      return c.length ? c[0].src : undefined;
    })(),
    hasVideoEl: !!document.querySelector("article video, main video"),
    hasVideoControls: [...document.querySelectorAll("article [aria-label], main [aria-label]")].some((e) =>
      /^(reproduzir|play|ativar som|desativar som|unmute|mute|clipe|clip)$/i.test(e.getAttribute("aria-label") || "")),
    captionText: (h1 && h1.textContent) || undefined,
    headerHandle: (() => { const a = [...document.querySelectorAll('article a[href^="/"]')].map(x => x.getAttribute("href")).find(h => /^\\/[A-Za-z0-9._]+\\/$/.test(h) && !/^\\/(p|reel|reels|explore|stories|accounts|direct)\\/$/.test(h)); return a ? a.slice(1, -1) : undefined; })(),
    bodyTextStart: ((document.body && document.body.innerText) || "").slice(0, 600),
  };
})()`;

const PROFILE_SCRIPT = `(() => ({
  finalUrl: location.href,
  hrefs: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") || "").slice(0, 400),
  bodyTextStart: ((document.body && document.body.innerText) || "").slice(0, 600),
}))()`;

const IG_IMAGE_HOST = /(\.|^)(cdninstagram\.com|fbcdn\.net)$/i;
const safeImage = (u: string | undefined): string | undefined => {
  if (!u) return undefined;
  try {
    const x = new URL(u);
    return x.protocol === "https:" && IG_IMAGE_HOST.test(x.hostname) ? x.toString() : undefined;
  } catch {
    return undefined;
  }
};

const SEEN_KEEP = 150;

const Shape = {
  handles: z.array(z.string().regex(/^@?[A-Za-z0-9._]{1,30}$/, "handle inválido")).min(1),
  role: z.enum(["outlet", "subject"]).optional(),
  postsPerHandle: z.number().int().min(1).max(12).default(3),
  limits: z
    .object({
      minDelaySeconds: z.number().nonnegative().default(20),
      maxPerHour: z.number().int().positive().default(40),
      cooldownMinutes: z.number().nonnegative().default(60),
    })
    .strict()
    .default({}),
};
type InstagramOptions = ReturnType<typeof parseIgOptions>;
const parseIgOptions = (cfg: SourceConfig) => parseOptions("instagram-profile", Shape, cfg);

export class InstagramProfileSource implements Source {
  readonly type = "instagram-profile";
  readonly name: string;

  constructor(private readonly o: InstagramOptions, private readonly deps: { logger: Logger; fetch?: typeof fetch; pageReader?: PageReader; sleep?: (ms: number) => Promise<void> }) {
    this.name = o.name ?? "instagram-profile";
  }

  private session(ctx: SourceContext): BrowserSession {
    return openBrowser(ctx, { limits: this.o.limits, stateKey: "ig.limiter", reader: this.deps.pageReader, fetch: this.deps.fetch, sleep: this.deps.sleep });
  }

  private async ensureAvailable(s: BrowserSession): Promise<void> {
    if (!(await s.isAvailable())) throw new BrowserError("O Chrome dedicado não está aberto. Rode scripts/chrome-reader.sh e entre com a conta secundária do Instagram.", "NOT_AVAILABLE");
  }

  /** Newest post URLs of a profile (one page visit). */
  async listProfilePosts(s: BrowserSession, handle: string, limit: number): Promise<string[]> {
    await this.ensureAvailable(s);
    const h = handle.replace(/^@/, "");
    const snap = await s.read<ProfileSnapshot>({ url: `https://www.instagram.com/${h}/`, script: PROFILE_SCRIPT, dwellMs: [3500, 8000], scrolls: 1, scrollPx: 300 });
    if (LOGIN_RE.test(snap.finalUrl)) throw new BrowserError("O Instagram pediu login no Chrome dedicado: abra-o e entre com a conta secundária.", "AUTH_REQUIRED");
    const links = extractProfileLinks(h, snap.hrefs, limit);
    if (!links.length && THROTTLED_RE.test(snap.bodyTextStart)) {
      s.limiter.trip();
      throw new BrowserError(`O Instagram pediu para reduzir o ritmo ou mostrou um desafio ao abrir @${h}.`, "RATE_LIMITED");
    }
    return links;
  }

  /** Reads one post page. */
  async readPost(s: BrowserSession, ref: InstagramPostRef, now: Date): Promise<ParsedPost> {
    await this.ensureAvailable(s);
    const snap = await s.read<PageSnapshot>({ url: ref.url, script: PAGE_SCRIPT, dwellMs: [3500, 8000], scrolls: 1, scrollPx: 150, readySelector: "article video, main video", readyTimeoutMs: 5000 });
    if (isLoginWall(snap)) throw new BrowserError("O Instagram pediu login ou confirmação de idade no Chrome dedicado: abra-o e resolva a tela manualmente.", "AUTH_REQUIRED");
    const post = parsePost(snap, now);
    if (!post.caption && !post.imageUrl) throw new BrowserError("Página sem legenda nem imagem (post removido ou layout mudou).", "NOT_FOUND");
    return post;
  }

  toRaw(ref: InstagramPostRef, p: ParsedPost, o: { origin: "profile" | "manual"; handleHint?: string }): RawItem {
    const handle = p.handle ?? ref.handle ?? o.handleHint ?? "";
    const image = safeImage(p.imageUrl);
    return {
      dedupeKey: `ig:${ref.code}`,
      origin: o.origin,
      source: this.name,
      sourceUrl: ref.url,
      author: handle,
      title: p.title,
      text: p.caption ?? "",
      // a video post carries a video marker only: its cover is a still of the player, never the video itself
      media: p.hasVideo ? [{ type: "video" }] : image ? [{ type: "image", url: image }] : [],
      postedAt: p.postedAt,
      engagement: { likes: p.likes, comments: p.comments },
      extra: { kind: ref.kind, hasVideo: p.hasVideo, displayName: p.displayName, role: this.o.role, coverUrl: p.hasVideo ? image : undefined },
    };
  }

  private seenKey = (h: string) => `ig.seen.${h.toLowerCase()}`;
  private seen(ctx: SourceContext, h: string): Set<string> {
    try {
      return new Set(JSON.parse(ctx.state.get(this.seenKey(h)) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  }
  private markSeen(ctx: SourceContext, h: string, code: string): void {
    const cur = [...this.seen(ctx, h)].filter((c) => c !== code);
    cur.push(code);
    ctx.state.set(this.seenKey(h), JSON.stringify(cur.slice(-SEEN_KEEP)));
  }

  async fetch(ctx: SourceContext): Promise<RawItem[]> {
    const s = this.session(ctx);
    const log = this.deps.logger;
    const out: RawItem[] = [];
    let stopped: BrowserError | undefined;
    for (const raw of this.o.handles) {
      const handle = raw.replace(/^@/, "");
      try {
        const links = await this.listProfilePosts(s, handle, 12);
        const seen = this.seen(ctx, handle);
        const firstContact = !ctx.state.get(this.seenKey(handle));
        const fresh = links.filter((u) => !seen.has(parseInstagramPostUrl(u)!.code)).slice(0, this.o.postsPerHandle);
        // first contact: the grid also shows old and pinned posts; remember the rest so they are not read later
        if (firstContact) for (const u of links.slice(this.o.postsPerHandle)) this.markSeen(ctx, handle, parseInstagramPostUrl(u)!.code);
        let failures = 0;
        for (const url of fresh) {
          const ref = parseInstagramPostUrl(url)!;
          try {
            const post = await this.readPost(s, ref, ctx.now);
            out.push(this.toRaw(ref, post, { origin: "profile", handleHint: handle }));
            this.markSeen(ctx, handle, ref.code);
          } catch (e) {
            if (isStopError(e)) throw e;
            log.warn(`${this.name}: ${url}: ${errMsg(e)}`);
            if (++failures >= 2) break;
          }
        }
      } catch (e) {
        if (isStopError(e)) {
          stopped = e;
          break;
        }
        log.warn(`${this.name}: @${handle}: ${errMsg(e)}`);
      }
    }
    if (stopped) {
      if (!out.length) throw stopped;
      log.warn(`${this.name}: leitura interrompida (${stopped.message}); devolvendo ${out.length} item(ns) já lidos`);
    }
    return out;
  }

  /** instagram.com/p|reel|tv URL -> that post. Profiles, stories and other hosts: undefined. */
  async fromInput(input: string, ctx: SourceContext): Promise<RawItem | undefined> {
    const ref = parseInstagramPostUrl(input.trim().split(/\s+/)[0] ?? "");
    if (!ref) return undefined;
    const post = await this.readPost(this.session(ctx), ref, ctx.now);
    return this.toRaw(ref, post, { origin: "manual" });
  }
}

export function createInstagramProfileSource(cfg: SourceConfig, deps: SourceDeps): Source {
  return new InstagramProfileSource(parseIgOptions(cfg), deps);
}
