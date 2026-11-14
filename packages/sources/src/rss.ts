import { KitError, errMsg, type Logger, type Media, type RawItem, type Source, type SourceConfig, type SourceContext } from "@auto-curator/contracts";
import { z } from "zod";
import { enrichArticle } from "./feed-media.js";
import type { SourceDeps } from "./types.js";
import { BOT_UA, canonicalUrl, hostOf, parseOptions, toIso } from "./util.js";
import { attrsOf, blocks, stripHtml, tagText, tags } from "./xml.js";

export interface FeedItem {
  title: string;
  link: string;
  summary: string;
  publishedAt?: string;
  author?: string;
  media: Media[];
}

const isImageType = (t: string | undefined) => !t || /^image\//i.test(t);

/** Parses RSS 2.0 (and RSS 1.0/RDF) and Atom. Items without a title or an http(s) link are dropped. */
export function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  const items = blocks(xml, "item");
  const entries = items.length ? items : blocks(xml, "entry");
  for (const it of entries) {
    const title = stripHtml(tagText(it, "title") ?? "");
    const link = feedLink(it);
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const rawBody = blocks(it, "content:encoded")[0] ?? blocks(it, "description")[0] ?? blocks(it, "summary")[0] ?? blocks(it, "content")[0] ?? "";
    const dateRaw = tagText(it, "pubDate") ?? tagText(it, "published") ?? tagText(it, "updated") ?? tagText(it, "dc:date");
    const authorBlock = blocks(it, "author")[0];
    const author =
      tagText(it, "dc:creator") ??
      (authorBlock ? (tagText(authorBlock, "name") ?? stripHtml(authorBlock)) : undefined) ??
      tagText(it, "source");
    out.push({
      title,
      link,
      summary: stripHtml(decodeBody(rawBody)).slice(0, 2000),
      publishedAt: toIso(dateRaw),
      author: author ? stripHtml(author) || undefined : undefined,
      media: feedMedia(it, decodeBody(rawBody)),
    });
  }
  return out;
}

/** Body text may be CDATA-wrapped HTML or entity-escaped HTML; both end as plain HTML. */
function decodeBody(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  if (cdata) return cdata[1]!;
  return /&lt;|&gt;/.test(raw) ? raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&") : raw;
}

function feedLink(it: string): string {
  const text = tagText(it, "link");
  if (text && /^https?:\/\//i.test(text)) return text.trim();
  const links = tags(it, "link");
  const best = links.find((l) => l.href && (!l.rel || l.rel === "alternate")) ?? links.find((l) => l.href);
  if (best?.href) return best.href.trim();
  const guid = tagText(it, "guid");
  return guid && /^https?:\/\//i.test(guid) ? guid.trim() : "";
}

function feedMedia(it: string, body: string): Media[] {
  const media: Media[] = [];
  const add = (type: "image" | "video", url: string | undefined) => {
    if (url && /^https?:\/\//i.test(url) && !media.some((m) => m.url === url)) media.push({ type, url });
  };
  for (const a of tags(it, "media:content")) {
    const video = a.medium === "video" || /^video\//i.test(a.type ?? "");
    if (video) add("video", a.url);
    else if (a.medium === "image" || isImageType(a.type)) add("image", a.url);
  }
  for (const a of tags(it, "media:thumbnail")) add("image", a.url);
  for (const a of tags(it, "enclosure")) {
    if (/^video\//i.test(a.type ?? "")) add("video", a.url);
    else if (/^image\//i.test(a.type ?? "")) add("image", a.url);
  }
  if (!media.some((m) => m.type === "image")) {
    const img = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(body)?.[1];
    if (img) add("image", attrsOf(`s="${img}"`).s);
  }
  return media;
}

export interface FeedSourceOptions {
  type: string;
  name: string;
  url: string;
  maxItems: number;
  fetchImage: boolean;
  timeoutSeconds: number;
}

/** Shared by "rss" and "google-news": fetches a feed URL, parses it and (optionally) looks up the article image. */
export class FeedSource implements Source {
  readonly type: string;
  readonly name: string;
  private readonly f: typeof fetch;
  private readonly log: Logger;

  constructor(private readonly o: FeedSourceOptions, deps: Pick<SourceDeps, "fetch" | "logger">) {
    this.type = o.type;
    this.name = o.name;
    this.f = deps.fetch ?? fetch;
    this.log = deps.logger;
  }

  async fetch(_ctx: SourceContext): Promise<RawItem[]> {
    const timeoutMs = this.o.timeoutSeconds * 1000;
    let body: string;
    try {
      const res = await this.f(this.o.url, { headers: { "user-agent": BOT_UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new KitError(`O feed "${this.name}" respondeu HTTP ${res.status}.`, "SOURCE_FETCH");
      body = await res.text();
    } catch (e) {
      if (e instanceof KitError) throw e;
      throw new KitError(`Não consegui ler o feed "${this.name}": ${errMsg(e)}`, "SOURCE_FETCH");
    }
    const items = parseFeed(body).slice(0, this.o.maxItems);
    if (!items.length && !/<(rss|feed|rdf:rdf)\b/i.test(body)) {
      throw new KitError(`A resposta de "${this.name}" não parece um feed RSS/Atom.`, "SOURCE_FETCH");
    }
    if (this.o.fetchImage) await this.enrich(items, timeoutMs);
    return items.map((it) => this.toRaw(it));
  }

  /** Looks up og:image (and the publisher URL of Google News links) with limited concurrency. */
  private async enrich(items: FeedItem[], timeoutMs: number): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const it = items[next++]!;
        const needImage = !it.media.some((m) => m.type === "image");
        try {
          const r = await enrichArticle(it.link, this.f, timeoutMs, { needImage });
          if (r.url) (it as FeedItem & { resolvedUrl?: string }).resolvedUrl = r.url;
          if (r.imageUrl && needImage) it.media.push({ type: "image", url: r.imageUrl });
        } catch (e) {
          this.log.debug(`${this.name}: sem imagem para ${it.link}: ${errMsg(e)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  }

  private toRaw(it: FeedItem & { resolvedUrl?: string }): RawItem {
    const publisher = hostOf(it.resolvedUrl ?? it.link);
    return {
      dedupeKey: `rss:${canonicalUrl(it.link)}`,
      origin: "feed",
      source: this.name,
      sourceUrl: it.resolvedUrl ?? it.link,
      author: it.author ?? "",
      title: it.title,
      text: it.summary || it.title,
      media: it.media,
      postedAt: it.publishedAt,
      engagement: {},
      extra: { feed: this.o.url, publisher: it.author ?? (publisher || undefined), feedLink: it.link },
    };
  }
}

const RssShape = {
  url: z.string().url(),
  maxItems: z.number().int().min(1).max(200).default(20),
  fetchImage: z.boolean().default(true),
  timeoutSeconds: z.number().positive().max(120).default(15),
};

export function createRssSource(cfg: SourceConfig, deps: SourceDeps): Source {
  const o = parseOptions("rss", RssShape, cfg);
  if (!/^https?:\/\//i.test(o.url)) throw new KitError(`Configuração inválida na fonte "rss": "url": use http:// ou https://.`, "SOURCE_CONFIG");
  return new FeedSource({ type: "rss", name: o.name ?? (hostOf(o.url) || "rss"), url: o.url, maxItems: o.maxItems, fetchImage: o.fetchImage, timeoutSeconds: o.timeoutSeconds }, deps);
}
