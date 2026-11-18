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

/** A plugin source: the factory, or `{ factory, override }` to replace a type that already exists. */
export type SourcePlugin = SourceFactory | { factory: SourceFactory; override?: boolean; description?: string };

export interface SourceEntry {
  factory: Factory;
  description: string;
  origin: "kit" | "registro" | "projeto";
}

const builtin: Record<BuiltinSourceType, Factory> = {
  rss: createRssSource,
  "google-news": createGoogleNewsSource,
  "google-trends": createGoogleTrendsSource,
  manual: createManualSource,
  "x-feed": createXFeedSource,
  "instagram-profile": createInstagramProfileSource,
};

/** Types added with the deprecated registerSource (global, kept for compatibility). */
const registered = new Map<string, { factory: Factory; description: string }>();

const TYPE_RE = /^[a-z][a-z0-9-]{0,40}$/;

/** @deprecated Passe `plugins.sources` a run/buildRuntime. Mantido por compatibilidade; sem registro global obrigatório. */
export function registerSource(type: string, factory: SourceFactory, opts: { description?: string; override?: boolean } = {}): void {
  if (!TYPE_RE.test(type)) throw new KitError(`Tipo de fonte inválido: "${type}" (use letras minúsculas, números e hífen).`, "SOURCE_REGISTER");
  if ((type in builtin || registered.has(type)) && !opts.override) throw new KitError(`Já existe uma fonte do tipo "${type}".`, "SOURCE_REGISTER");
  registered.set(type, { factory: factory as Factory, description: opts.description ?? "Fonte de plugin." });
}

/** Removes a plugin registered with registerSource (mainly for tests). */
export function unregisterSource(type: string): void {
  registered.delete(type);
}

/**
 * Tabela de tipos: kit, depois registerSource, depois `plugins` do projeto.
 * Um tipo do projeto que já existe é erro, a menos que venha com override: true.
 */
export function sourceTable(plugins: Record<string, SourcePlugin> = {}): Map<string, SourceEntry> {
  const table = new Map<string, SourceEntry>();
  for (const s of SOURCE_TYPES) table.set(s.type, { factory: builtin[s.type], description: s.description, origin: "kit" });
  for (const [type, r] of registered) table.set(type, { ...r, origin: "registro" });
  for (const [type, raw] of Object.entries(plugins)) {
    if (!TYPE_RE.test(type)) throw new KitError(`Tipo de fonte inválido: "${type}" (use letras minúsculas, números e hífen).`, "SOURCE_REGISTER");
    const p = typeof raw === "function" ? { factory: raw } : raw;
    const existing = table.get(type);
    if (existing && !p.override) throw new KitError(`Já existe a fonte "${type}" (${existing.origin}). Use override: true para substituí-la.`, "SOURCE_REGISTER");
    table.set(type, { factory: p.factory as Factory, description: p.description ?? "Fonte do projeto.", origin: "projeto" });
  }
  return table;
}

/** Built-ins plus registered plugins. */
export function listSourceTypes(table: Map<string, SourceEntry> = sourceTable()): SourceTypeInfo[] {
  return [...table].map(([type, e]) => ({ type, description: e.description }));
}

export function createSource(cfg: SourceConfig, deps: SourceDeps, table: Map<string, SourceEntry> = sourceTable()): Source {
  const entry = table.get(cfg.type);
  if (!entry) {
    throw new KitError(`Tipo de fonte desconhecido: "${cfg.type}". Tipos disponíveis: ${[...table.keys()].join(", ")}.`, "SOURCE_UNKNOWN_TYPE");
  }
  return entry.factory(cfg, deps);
}

/** Builds every enabled source of a profile (entries with `enabled: false` are skipped). */
export function createSources(cfgs: readonly SourceConfig[], deps: SourceDeps, table: Map<string, SourceEntry> = sourceTable()): Source[] {
  return cfgs.filter((c) => c.enabled !== false).map((c) => createSource(c, deps, table));
}
