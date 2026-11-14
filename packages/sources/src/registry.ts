import { KitError, type Source, type SourceConfig, type SourceFactory } from "@auto-curator/contracts";
import { createGoogleNewsSource } from "./google-news.js";
import { createGoogleTrendsSource } from "./google-trends.js";
import { createInstagramProfileSource } from "./instagram-profile.js";
import { createManualSource } from "./manual.js";
import { createRssSource } from "./rss.js";
import type { SourceDeps } from "./types.js";
import { createXFeedSource } from "./x-feed.js";

/** Built-in source types, with a one-line description (pt-BR) used by `doctor` and the docs. */
export const SOURCE_TYPES = [
  { type: "rss", description: "Feed RSS 2.0 ou Atom de um site (opções: url, maxItems, fetchImage)." },
  { type: "google-news", description: "Busca no Google Notícias por palavra-chave (opções: query, hl, gl, ceid)." },
  { type: "google-trends", description: "Assuntos em alta no Google Trends de um país, com as notícias relacionadas (opção: geo)." },
  { type: "manual", description: "Itens que você envia pelo bot (/add): link de página ou texto livre." },
  { type: "x-feed", description: "Linha do tempo da conta de leitura no X, via Chrome dedicado (opções: feed, minChars, minLikes). Uso sujeito aos Termos do X." },
  { type: "instagram-profile", description: "Posts novos de perfis do Instagram, via Chrome dedicado (opções: handles, postsPerHandle). Uso sujeito aos Termos do Instagram." },
] as const;

export type BuiltinSourceType = (typeof SOURCE_TYPES)[number]["type"];
export type SourceTypeInfo = { type: string; description: string };

type Factory = (cfg: SourceConfig, deps: SourceDeps) => Source;

const builtin: Record<BuiltinSourceType, Factory> = {
  rss: createRssSource,
  "google-news": createGoogleNewsSource,
  "google-trends": createGoogleTrendsSource,
  manual: createManualSource,
  "x-feed": createXFeedSource,
  "instagram-profile": createInstagramProfileSource,
};

const plugins = new Map<string, { factory: Factory; description: string }>();

/** Registers a third-party source type. Throws if the type already exists, unless `override` is set. */
export function registerSource(type: string, factory: SourceFactory, opts: { description?: string; override?: boolean } = {}): void {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(type)) throw new KitError(`Tipo de fonte inválido: "${type}" (use letras minúsculas, números e hífen).`, "SOURCE_REGISTER");
  if ((type in builtin || plugins.has(type)) && !opts.override) throw new KitError(`Já existe uma fonte do tipo "${type}".`, "SOURCE_REGISTER");
  plugins.set(type, { factory: factory as Factory, description: opts.description ?? "Fonte de plugin." });
}

/** Removes a plugin registered with registerSource (mainly for tests). */
export function unregisterSource(type: string): void {
  plugins.delete(type);
}

/** Built-ins plus registered plugins. */
export function listSourceTypes(): SourceTypeInfo[] {
  return [...SOURCE_TYPES.map((s) => ({ type: s.type as string, description: s.description as string })), ...[...plugins].map(([type, p]) => ({ type, description: p.description }))];
}

export function createSource(cfg: SourceConfig, deps: SourceDeps): Source {
  const entry = plugins.get(cfg.type);
  const factory: Factory | undefined = entry?.factory ?? (Object.hasOwn(builtin, cfg.type) ? builtin[cfg.type as BuiltinSourceType] : undefined);
  if (!factory) {
    throw new KitError(`Tipo de fonte desconhecido: "${cfg.type}". Tipos disponíveis: ${listSourceTypes().map((s) => s.type).join(", ")}.`, "SOURCE_UNKNOWN_TYPE");
  }
  return factory(cfg, deps);
}

/** Builds every enabled source of a profile (entries with `enabled: false` are skipped). */
export function createSources(cfgs: readonly SourceConfig[], deps: SourceDeps): Source[] {
  return cfgs.filter((c) => c.enabled !== false).map((c) => createSource(c, deps));
}
