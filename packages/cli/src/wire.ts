import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_REJECT_REASONS,
  type ApprovalUiConfig,
  type Logger,
  type Notifier,
  type Preparer,
  type Publisher,
  type Source,
} from "@auto-curator/contracts";
import { App, ConfigError, FilePromptProvider, LlmClient, Store, createLogger, loadProfile, loadVeto, type ProfileBundle, type VetoRules } from "@auto-curator/engine";
import { createDownloaderFromEnv, createPreparer } from "@auto-curator/media";
import { createSource, orderForInput, type SourceEntry } from "@auto-curator/sources";
import { TelegramApi, TelegramBot } from "@auto-curator/telegram";
import { resolveParts } from "./checks.js";
import type { KitPlugins } from "./plugins.js";

export interface Runtime {
  bundle: ProfileBundle;
  store: Store;
  llm: LlmClient;
  prompts: FilePromptProvider;
  veto: VetoRules | undefined;
  sources: Source[];
  preparer: Preparer;
  publishers: Record<string, Publisher>;
  app: App;
  bot?: TelegramBot;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  /** Closes the SQLite database. */
  close(): void;
}

export interface BuildOptions {
  withTelegram?: boolean;
  logger?: Logger;
  /** Test seam for the Telegram API. */
  telegramFetch?: typeof fetch;
  /** Extension points of the project (seção 3): sources, publishers, mediaHost. */
  plugins?: KitPlugins;
}

/** TELEGRAM_ALLOWED_CHAT_IDS (comma/space separated); falls back to the legacy singular TELEGRAM_ALLOWED_CHAT_ID. */
export function parseChatIds(env: NodeJS.ProcessEnv): string[] {
  const raw = env.TELEGRAM_ALLOWED_CHAT_IDS?.trim() || env.TELEGRAM_ALLOWED_CHAT_ID?.trim() || "";
  return [...new Set(raw.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean))];
}

/** TELEGRAM_ALLOWED_USER_IDS (optional, same format): when set, the sender must be listed too. */
export function parseUserIds(env: NodeJS.ProcessEnv): string[] {
  return [...new Set((env.TELEGRAM_ALLOWED_USER_IDS?.trim() ?? "").split(/[,\s;]+/).map((x) => x.trim()).filter(Boolean))];
}

export function uiConfig(bundle: ProfileBundle): ApprovalUiConfig {
  const p = bundle.profile;
  return {
    profileName: p.name,
    credit: p.editorial.credit,
    destinations: p.destinations,
    rejectReasons: p.telegram.rejectReasons === "default" ? DEFAULT_REJECT_REASONS : p.telegram.rejectReasons,
    timezone: p.timezone,
  };
}

/** Sources of the profile (enabled entries only), "manual" last so /add tries the specific ones first. */
export function buildSources(bundle: ProfileBundle, env: NodeJS.ProcessEnv, logger: Logger, table?: Map<string, SourceEntry>): Source[] {
  const sources = bundle.profile.sources.filter((s) => s.enabled !== false).map((cfg) => createSource(cfg, { env, logger }, table));
  return orderForInput(sources);
}

/** Loads the profile and wires the whole application. Nothing here touches the network. */
export function buildRuntime(profileDir: string, env: NodeJS.ProcessEnv, opts: BuildOptions = {}): Runtime {
  const bundle = loadProfile(profileDir, env);
  const logger = opts.logger ?? createLogger();
  const { profile } = bundle;

  // Antes de qualquer banco ou rede: fontes, publicadores, host e variáveis das partes ligadas.
  const parts = resolveParts(bundle, env, { plugins: opts.plugins, withTelegram: opts.withTelegram });
  for (const w of parts.issues.filter((i) => i.level === "warning")) logger.warn(w.text);
  const errors = parts.issues.filter((i) => i.level === "error");
  if (errors.length) throw new ConfigError(`Configuração inválida:\n${errors.map((e) => `  - ${e.text}`).join("\n")}`);

  mkdirSync(bundle.dataDir, { recursive: true });
  const store = new Store({ path: join(bundle.dataDir, "curator.db"), timezone: profile.timezone });
  try {
    const llm = new LlmClient({ models: bundle.models, store, env, logger });
    const prompts = new FilePromptProvider({ profileDir: bundle.profileDir, templateDir: bundle.templateDir, profile, draftExtraRequired: bundle.template.draftExtraRequired });
    const veto = loadVeto(bundle.profileDir, profile.editorial, logger);
    const sources = buildSources(bundle, env, logger, parts.table);
    const preparer = createPreparer(profile, { logger, downloader: createDownloaderFromEnv(env) });

    const publishers: Record<string, Publisher> = parts.publishers;

    // The bot needs the App (actions) and the App needs the bot (notifier): break the cycle with a late-bound proxy.
    let bot: TelegramBot | undefined;
    const notifier: Notifier | undefined = opts.withTelegram
      ? {
          sendApproval: (item) => {
            if (!bot) throw new Error("bot do Telegram ainda não iniciado");
            return bot.sendApproval(item);
          },
          notify: (text) => (bot ? bot.notify(text) : Promise.resolve()),
        }
      : undefined;

    const app = new App({ bundle, store, llm, prompts, sources, preparer, publishers, notifier, logger, env, veto });

    if (opts.withTelegram) {
      // as variáveis do Telegram já foram conferidas em resolveParts
      const token = env.TELEGRAM_BOT_TOKEN?.trim() as string;
      bot = new TelegramBot({ api: new TelegramApi(token, opts.telegramFetch), allowedChatIds: parseChatIds(env), allowedUserIds: parseUserIds(env), store, actions: app, ui: uiConfig(bundle), logger });
    }

    return { bundle, store, llm, prompts, veto, sources, preparer, publishers, app, bot, logger, env, close: () => store.close() };
  } catch (e) {
    store.close();
    throw e;
  }
}
