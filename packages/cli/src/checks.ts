import { errMsg, silentLogger, type MediaHost, type Publisher } from "@auto-curator/contracts";
import { type ProfileBundle } from "@auto-curator/engine";
import { createBufferFromEnv, createMediaHostFromEnv } from "@auto-curator/publishers";
import { createSource, sourceTable, type SourceEntry } from "@auto-curator/sources";
import type { KitPlugins } from "./plugins.js";

/**
 * "profile": perfil e formato; "source": tipos e opções das fontes; "publisher": ids de destino;
 * "host": host de mídia; "env-*": variável de ambiente exigida pela parte ligada (o doctor já mostra essas).
 */
export type IssueKind = "profile" | "source" | "publisher" | "host" | "env-models" | "env-telegram" | "env-buffer" | "env-host";

export interface ConfigIssue {
  level: "error" | "warning";
  kind: IssueKind;
  /** Mensagem em português; nunca traz valor de variável de ambiente. */
  text: string;
}

export interface RuntimeParts {
  table: Map<string, SourceEntry>;
  publishers: Record<string, Publisher>;
  mediaHost: MediaHost | undefined;
  issues: ConfigIssue[];
}

export interface ResolveOptions {
  plugins?: KitPlugins;
  withTelegram?: boolean;
}

const has = (env: NodeJS.ProcessEnv, name: string): boolean => Boolean(env[name]?.trim());

/**
 * Resolve o que o runtime precisa (tabela de fontes, publicadores, host) e confere a configuração
 * contra eles, sem rede. Quem chama decide: buildRuntime lança se houver erro; o doctor mostra tudo.
 */
export function resolveParts(bundle: ProfileBundle, env: NodeJS.ProcessEnv, opts: ResolveOptions = {}): RuntimeParts {
  const { plugins } = opts;
  const issues: ConfigIssue[] = bundle.warnings.map((text) => ({ level: "warning" as const, kind: "profile" as const, text }));
  const { profile, models } = bundle;

  let table: Map<string, SourceEntry>;
  try {
    table = sourceTable(plugins?.sources ?? {});
  } catch (e) {
    issues.push({ level: "error", kind: "source", text: `plugins.sources: ${errMsg(e)}` });
    table = sourceTable();
  }

  let mediaHost: MediaHost | undefined;
  try {
    const p = plugins?.mediaHost;
    mediaHost = p === undefined ? createMediaHostFromEnv(env) : typeof p === "function" ? p(env) : p;
  } catch (e) {
    issues.push({ level: "error", kind: "host", text: `plugins.mediaHost: ${errMsg(e)}` });
  }

  let publishers: Record<string, Publisher> = {};
  const pubPlugin = plugins?.publishers;
  try {
    if (pubPlugin !== undefined) publishers = typeof pubPlugin === "function" ? pubPlugin(env, mediaHost) : { ...pubPlugin };
    else {
      const buffer = createBufferFromEnv(env, profile.destinations, mediaHost);
      if (buffer) publishers = { buffer };
    }
  } catch (e) {
    issues.push({ level: "error", kind: "publisher", text: `plugins.publishers: ${errMsg(e)}` });
  }

  profile.sources.forEach((cfg, i) => {
    if (!table.has(cfg.type)) {
      issues.push({ level: "error", kind: "source", text: `sources[${i}].type: tipo "${cfg.type}" desconhecido (disponíveis: ${[...table.keys()].join(", ")})` });
      return;
    }
    if (cfg.enabled === false) return;
    try {
      createSource(cfg, { env, logger: silentLogger }, table);
    } catch (e) {
      issues.push({ level: "error", kind: "source", text: `sources[${i}]: ${errMsg(e)}` });
    }
  });

  profile.destinations.forEach((d, i) => {
    if (d.publisher === "manual") return;
    const at = `destinations[${i}] (${d.platform})`;
    if (!publishers[d.publisher]) {
      if (d.publisher === "buffer" && pubPlugin === undefined) {
        issues.push({ level: "error", kind: "env-buffer", text: `${at}: o publicador "buffer" precisa da variável BUFFER_API_KEY (ou passe plugins.publishers).` });
      } else {
        const ids = Object.keys(publishers);
        issues.push({ level: "error", kind: "publisher", text: `${at}: publicador "${d.publisher}" não existe. Disponíveis: ${ids.length ? ids.join(", ") : "nenhum"}.` });
      }
    }
    if (profile.media.strategy !== "none" && !mediaHost) {
      if (d.publisher === "buffer" && pubPlugin === undefined) {
        issues.push({ level: "error", kind: "env-host", text: `${at}: destino com mídia no Buffer precisa de host de mídia: defina IMGBB_API_KEY ou as variáveis R2_*, ou passe plugins.mediaHost.` });
      } else {
        issues.push({ level: "warning", kind: "host", text: `${at}: destino com mídia sem host de mídia; publicadores que exigem URL pública vão falhar (passe plugins.mediaHost).` });
      }
    }
  });

  for (const role of ["triage", "curator"] as const) {
    const r = models.roles[role];
    if (!has(env, r.apiKeyEnv)) issues.push({ level: "error", kind: "env-models", text: `models.json: variável ${r.apiKeyEnv} (chave do modelo "${role}") não está definida.` });
    const fb = r.fallback === undefined ? [] : Array.isArray(r.fallback) ? r.fallback : [r.fallback];
    for (const f of fb) {
      if (!has(env, f.apiKeyEnv)) issues.push({ level: "warning", kind: "env-models", text: `models.json: variável ${f.apiKeyEnv} (fallback de "${role}") não está definida; esse fallback não vai funcionar.` });
    }
  }

  if (opts.withTelegram) {
    if (!has(env, "TELEGRAM_BOT_TOKEN")) issues.push({ level: "error", kind: "env-telegram", text: "TELEGRAM_BOT_TOKEN não definido. Crie o bot no @BotFather e preencha o .env do perfil." });
    const chats = (env.TELEGRAM_ALLOWED_CHAT_IDS ?? env.TELEGRAM_ALLOWED_CHAT_ID ?? "").trim();
    if (!chats) issues.push({ level: "error", kind: "env-telegram", text: "TELEGRAM_ALLOWED_CHAT_IDS não definido. Informe o(s) id(s) de chat autorizados a aprovar (use @userinfobot)." });
  }

  return { table, publishers, mediaHost, issues };
}
