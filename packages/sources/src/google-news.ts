import type { Source, SourceConfig } from "@auto-curator/contracts";
import { z } from "zod";
import { FeedSource } from "./rss.js";
import type { SourceDeps } from "./types.js";
import { parseOptions } from "./util.js";

export function buildGoogleNewsUrl(o: { query: string; hl?: string; gl?: string; ceid?: string }): string {
  const u = new URL("https://news.google.com/rss/search");
  u.searchParams.set("q", o.query);
  u.searchParams.set("hl", o.hl ?? "pt-BR");
  u.searchParams.set("gl", o.gl ?? "BR");
  u.searchParams.set("ceid", o.ceid ?? "BR:pt-419");
  return u.toString();
}

const Shape = {
  query: z.string().min(1),
  hl: z.string().min(2).default("pt-BR"),
  gl: z.string().length(2).default("BR"),
  ceid: z.string().min(3).default("BR:pt-419"),
  maxItems: z.number().int().min(1).max(100).default(15),
  fetchImage: z.boolean().default(true),
  timeoutSeconds: z.number().positive().max(120).default(15),
};

export function createGoogleNewsSource(cfg: SourceConfig, deps: SourceDeps): Source {
  const o = parseOptions("google-news", Shape, cfg);
  const label = o.query.length > 40 ? `${o.query.slice(0, 40)}…` : o.query;
  return new FeedSource(
    { type: "google-news", name: o.name ?? `Google News: ${label}`, url: buildGoogleNewsUrl(o), maxItems: o.maxItems, fetchImage: o.fetchImage, timeoutSeconds: o.timeoutSeconds },
    deps,
  );
}
