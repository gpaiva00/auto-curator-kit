import { type RawItem, type Source, type SourceConfig, type SourceContext } from "@auto-curator/contracts";
import { z } from "zod";
import { articleText, metaTags, pageTitle } from "./html.js";
import { readHtml } from "./page.js";
import type { SourceDeps } from "./types.js";
import { canonicalUrl, hostOf, isHttpUrl, isPublicUrl, parseOptions, sha256, toIso } from "./util.js";
import { isInstagramHost, isXHost } from "./urls.js";
import { parseArticleMetaImage } from "./page.js";

/**
 * Items the human adds by hand (/add). `fetch` never returns anything: the engine calls `fromInput`.
 * It must be asked LAST (see orderForInput) so x-feed and instagram-profile can claim their own links first.
 */
export class ManualSource implements Source {
  readonly type = "manual";
  readonly name: string;
  private readonly f: typeof fetch;

  constructor(name: string, private readonly o: { timeoutSeconds: number }, private readonly deps: Pick<SourceDeps, "fetch" | "logger">) {
    this.name = name;
    this.f = deps.fetch ?? fetch;
  }

  async fetch(_ctx: SourceContext): Promise<RawItem[]> {
    return [];
  }

  async fromInput(input: string, ctx: SourceContext): Promise<RawItem | undefined> {
    const text = input.trim();
    if (!text) return undefined;
    const [first = ""] = text.split(/\s+/);
    if (isHttpUrl(first)) {
      // X and Instagram links belong to their own sources (they need the logged-in browser)
      if (isXHost(first) || isInstagramHost(first)) return undefined;
      const pasted = text.slice(first.length).trim();
      return this.fromUrl(first, pasted, ctx.now);
    }
    return {
      dedupeKey: `manual:${sha256(text.toLowerCase().replace(/\s+/g, " ")).slice(0, 24)}`,
      origin: "manual",
      source: this.name,
      author: "",
      text,
      media: [],
      engagement: {},
      extra: { kind: "text" },
    };
  }

  private async fromUrl(url: string, pastedText: string, now: Date): Promise<RawItem> {
    const key = `manual:url:${canonicalUrl(url)}`;
    const page = isPublicUrl(url, { allowHttp: true }) ? await readHtml(url, this.f, { timeoutMs: this.o.timeoutSeconds * 1000, allowHttp: true }) : undefined;
    if (!page) {
      this.deps.logger.warn(`manual: não consegui ler a página ${url}${isPublicUrl(url, { allowHttp: true }) ? "" : " (endereço não público)"}`);
      return { dedupeKey: key, origin: "manual", source: this.name, sourceUrl: url, author: hostOf(url), text: pastedText || url, media: [], engagement: {}, extra: { kind: "url", fetched: false } };
    }
    const meta = metaTags(page.html);
    const title = meta["og:title"] ?? meta["twitter:title"] ?? pageTitle(page.html);
    const description = meta["og:description"] ?? meta["twitter:description"] ?? meta.description;
    const body = articleText(page.html);
    const image = parseArticleMetaImage(page.html, page.finalUrl);
    const author = meta["article:author"] && !isHttpUrl(meta["article:author"]) ? meta["article:author"] : (meta.author ?? meta["og:site_name"] ?? hostOf(page.finalUrl));
    return {
      dedupeKey: key,
      origin: "manual",
      source: this.name,
      sourceUrl: url,
      author,
      title,
      // what the human pasted wins; otherwise the article body, otherwise the page description
      text: pastedText || body || description || title || url,
      media: image ? [{ type: "image", url: image }] : [],
      postedAt: toIso(meta["article:published_time"] ?? meta["og:article:published_time"] ?? meta.date),
      engagement: {},
      extra: { kind: "url", fetched: true, description, siteName: meta["og:site_name"], finalUrl: page.finalUrl !== url ? page.finalUrl : undefined, fetchedAt: now.toISOString() },
    };
  }
}

/** Puts "manual" sources last (stable otherwise): every other source gets to claim the input first. */
export function orderForInput<T extends { type: string }>(sources: readonly T[]): T[] {
  return [...sources.filter((s) => s.type !== "manual"), ...sources.filter((s) => s.type === "manual")];
}

const Shape = { timeoutSeconds: z.number().positive().max(120).default(15) };

export function createManualSource(cfg: SourceConfig, deps: SourceDeps): Source {
  const o = parseOptions("manual", Shape, cfg);
  return new ManualSource(o.name ?? "manual", { timeoutSeconds: o.timeoutSeconds }, deps);
}

