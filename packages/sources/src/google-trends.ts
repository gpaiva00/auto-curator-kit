import { KitError, errMsg, type RawItem, type Source, type SourceConfig, type SourceContext } from "@auto-curator/contracts";
import { z } from "zod";
import type { SourceDeps } from "./types.js";
import { BOT_UA, fold, parseOptions, toIso } from "./util.js";
import { blocks, tagText } from "./xml.js";

export interface TrendNews {
  title: string;
  url: string;
  source?: string;
}
export interface TrendCandidate {
  name: string;
  /** Parsed from "200+", "2 mil+", "1 mi+" ... (0 if unknown). */
  approxTraffic: number;
  publishedAt?: string;
  news: TrendNews[];
}

export function parseTraffic(raw: string | undefined): number {
  if (!raw) return 0;
  const m = /([\d.,]+)\s*(mil|mi|milh[oõ]es|k|m)?\s*\+?/i.exec(raw.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]!.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) return 0;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "mil" || unit === "k") return n * 1_000;
  if (unit === "mi" || unit === "m" || unit.startsWith("milh")) return n * 1_000_000;
  return n;
}

/** Parses the Google Trends "trending now" RSS (https://trends.google.com/trending/rss?geo=BR). */
export function parseTrendsRss(xml: string): TrendCandidate[] {
  const out: TrendCandidate[] = [];
  for (const item of blocks(xml, "item")) {
    const name = tagText(item, "title");
    if (!name) continue;
    out.push({
      name,
      approxTraffic: parseTraffic(tagText(item, "ht:approx_traffic")),
      publishedAt: toIso(tagText(item, "pubDate")),
      news: blocks(item, "ht:news_item")
        .map((n) => ({
          title: tagText(n, "ht:news_item_title") ?? "",
          url: tagText(n, "ht:news_item_url") ?? "",
          source: tagText(n, "ht:news_item_source"),
        }))
        .filter((n) => n.url && n.title),
    });
  }
  return out;
}

export const trendsUrl = (geo: string): string => `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;

const Shape = {
  geo: z.string().regex(/^[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?$/, "código de país inválido (ex.: BR, US, PT)").default("BR"),
  maxItems: z.number().int().min(1).max(100).default(20),
  minTraffic: z.number().nonnegative().default(0),
  timeoutSeconds: z.number().positive().max(120).default(20),
};

export class GoogleTrendsSource implements Source {
  readonly type = "google-trends";
  readonly name: string;
  private readonly f: typeof fetch;

  constructor(private readonly o: { name: string; geo: string; maxItems: number; minTraffic: number; timeoutSeconds: number }, deps: Pick<SourceDeps, "fetch">) {
    this.name = o.name;
    this.f = deps.fetch ?? fetch;
  }

  async fetch(ctx: SourceContext): Promise<RawItem[]> {
    const url = trendsUrl(this.o.geo);
    let body: string;
    try {
      const res = await this.f(url, { headers: { "user-agent": BOT_UA, accept: "application/rss+xml, text/xml" }, signal: AbortSignal.timeout(this.o.timeoutSeconds * 1000) });
      if (!res.ok) throw new KitError(`O Google Trends respondeu HTTP ${res.status}.`, "SOURCE_FETCH");
      body = await res.text();
    } catch (e) {
      if (e instanceof KitError) throw e;
      throw new KitError(`Não consegui ler o Google Trends: ${errMsg(e)}`, "SOURCE_FETCH");
    }
    return parseTrendsRss(body)
      .filter((t) => t.approxTraffic >= this.o.minTraffic)
      .sort((a, b) => b.approxTraffic - a.approxTraffic)
      .slice(0, this.o.maxItems)
      .map((t) => this.toRaw(t, url, ctx.now));
  }

  private toRaw(t: TrendCandidate, url: string, now: Date): RawItem {
    const day = (t.publishedAt ?? now.toISOString()).slice(0, 10);
    const newsLines = t.news.map((n) => `- ${n.title}${n.source ? ` (${n.source})` : ""}`);
    return {
      dedupeKey: `trend:${this.o.geo.toUpperCase()}:${fold(t.name).replace(/\s+/g, "-")}:${day}`,
      origin: "feed",
      source: this.name,
      sourceUrl: t.news[0]?.url ?? url,
      author: "",
      title: t.name,
      text: newsLines.length ? `${t.name}\n\n${newsLines.join("\n")}` : t.name,
      media: [],
      postedAt: t.publishedAt,
      engagement: {},
      extra: { trend: true, geo: this.o.geo.toUpperCase(), approxTraffic: t.approxTraffic, news: t.news },
    };
  }
}

export function createGoogleTrendsSource(cfg: SourceConfig, deps: SourceDeps): Source {
  const o = parseOptions("google-trends", Shape, cfg);
  return new GoogleTrendsSource({ name: o.name ?? `Google Trends ${o.geo.toUpperCase()}`, geo: o.geo, maxItems: o.maxItems, minTraffic: o.minTraffic, timeoutSeconds: o.timeoutSeconds }, deps);
}
