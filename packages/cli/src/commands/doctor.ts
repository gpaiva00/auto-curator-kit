import { accessSync, constants, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Destination, ModelsConfig } from "@auto-curator/contracts";
import { errMsg, silentLogger } from "@auto-curator/contracts";
import { FilePromptProvider, Store, loadProfile, type ProfileBundle } from "@auto-curator/engine";
import { createDownloaderFromEnv, ffmpegAvailable } from "@auto-curator/media";
import { channelsFromEnv, createBufferFromEnv, createMediaHostFromEnv } from "@auto-curator/publishers";
import { createSource, resolveCdpUrl } from "@auto-curator/sources";
import { TelegramApi } from "@auto-curator/telegram";
import type { CmdCtx } from "../io.js";
import { brl } from "../format.js";
import { resolveProfile } from "../profile.js";
import { parseChatIds } from "../wire.js";

export type Level = "ok" | "warn" | "fail";
export interface Check {
  level: Level;
  label: string;
  hint?: string;
}

const ICON: Record<Level, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };
export const formatCheck = (c: Check): string => `${ICON[c.level]} ${c.label}${c.hint ? ` — ${c.hint}` : ""}`;

/** Browser-based source types need the dedicated Chrome. */
const BROWSER_SOURCES = new Set(["x-feed", "instagram-profile"]);
const PLACEHOLDER = /\(preencher\)|\(seu nome\)|\(vazio\)|<seu nome>/i;

/** Every API key env name of a role: primary first, then fallbacks. */
export function roleKeyEnvs(role: ModelsConfig["roles"]["triage"]): string[] {
  const fb = role.fallback === undefined ? [] : Array.isArray(role.fallback) ? role.fallback : [role.fallback];
  return [...new Set([role.apiKeyEnv, ...fb.map((f) => f.apiKeyEnv)])];
}

export interface DoctorOptions {
  offline: boolean;
  fetch?: typeof fetch;
}

/** Runs every check; never throws. */
export async function runChecks(profileDir: string, env: NodeJS.ProcessEnv, opts: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (level: Level, label: string, hint?: string) => void checks.push({ level, label, hint });
  const guard = async (what: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
    } catch (e) {
      add("fail", what, errMsg(e));
    }
  };

  let bundle: ProfileBundle;
  try {
    bundle = loadProfile(profileDir, env);
  } catch (e) {
    add("fail", "profile.json válido", errMsg(e));
    return checks;
  }
  const { profile, template, models } = bundle;
  add("ok", `profile.json válido: ${profile.name} (${profile.id})`);
  add("ok", `Template "${template.name}" encontrado`);
  add("ok", `models.json válido (teto de ${brl(models.monthlyBudgetBRL)}/mês)`);

  // prompts + versions
  await guard("Prompts", () => {
    const prompts = new FilePromptProvider({ profileDir: bundle.profileDir, templateDir: bundle.templateDir, profile, draftExtraRequired: template.draftExtraRequired });
    const v = (["triage", "curator"] as const).map((r) => prompts.get(r).version);
    add("ok", `Prompts presentes: ${v.join(", ")}`);
  });

  // style guide
  const styleFile = join(profileDir, "style-guide.md");
  if (!existsSync(styleFile)) add("fail", "style-guide.md presente", `crie ${styleFile} (voz, público, assuntos sim/não)`);
  else {
    const style = readFileSync(styleFile, "utf8");
    if (!style.trim()) add("fail", "style-guide.md presente", "o arquivo está vazio");
    else if (PLACEHOLDER.test(style)) add("warn", "style-guide.md ainda tem trechos a preencher", "procure por \"(preencher)\"");
    else add("ok", "style-guide.md preenchido");
  }

  // API keys per role
  for (const role of ["triage", "curator"] as const) {
    const names = roleKeyEnvs(models.roles[role]);
    const set = names.filter((n) => env[n]?.trim());
    if (set.length === 0) add("fail", `Chave de API para "${role}"`, `defina ao menos uma: ${names.join(", ")}`);
    else add("ok", `Chave de API para "${role}": ${set.join(", ")}${set.length < names.length ? ` (sem: ${names.filter((n) => !set.includes(n)).join(", ")})` : ""}`);
  }

  // budget
  await guard("Gasto do mês", () => {
    const dbFile = join(bundle.dataDir, "curator.db");
    if (!existsSync(dbFile)) return add("ok", `Gasto do mês: R$ 0,00 de ${brl(models.monthlyBudgetBRL)} (banco ainda não criado)`);
    const store = new Store({ path: dbFile, timezone: profile.timezone });
    try {
      const spent = store.monthSpendBRL();
      const pct = (spent / models.monthlyBudgetBRL) * 100;
      add(pct >= 100 ? "fail" : pct >= 80 ? "warn" : "ok", `Gasto do mês: ${brl(spent)} de ${brl(models.monthlyBudgetBRL)} (${pct.toFixed(0)}%)`, pct >= 100 ? "orçamento esgotado: a IA fica parada até o mês virar" : undefined);
    } finally {
      store.close();
    }
  });

  // Telegram
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chats = parseChatIds(env);
  if (!token) add("fail", "Telegram: TELEGRAM_BOT_TOKEN", "crie o bot no @BotFather e preencha o .env");
  else if (opts.offline) add("ok", "Telegram: token definido (não testado: --offline)");
  else
    await guard("Telegram: getMe", async () => {
      const me = await new TelegramApi(token, opts.fetch).call<{ username?: string }>("getMe");
      add("ok", `Bot do Telegram: @${me.username ?? "?"}`);
    });
  if (chats.length === 0) add("fail", "Telegram: TELEGRAM_ALLOWED_CHAT_IDS", "informe seu chat id (use @userinfobot); sem isso ninguém aprova");
  else add("ok", `Telegram: ${chats.length} chat(s) autorizado(s)`);

  // sources
  const enabled = profile.sources.filter((s) => s.enabled !== false);
  if (enabled.length === 0) add("warn", "Fontes", "nenhuma fonte ativa no profile.json");
  const cdpNeeded: string[] = [];
  for (const cfg of enabled) {
    const label = `Fonte ${cfg.type}${cfg.name ? ` "${cfg.name}"` : ""}`;
    try {
      createSource(cfg, { env, logger: silentLogger });
      add("ok", label);
      if (BROWSER_SOURCES.has(cfg.type)) cdpNeeded.push(cfg.type);
    } catch (e) {
      add("fail", label, errMsg(e));
    }
  }
  if (cdpNeeded.length) {
    const url = resolveCdpUrl(env);
    if (opts.offline) add("ok", `Chrome (CDP) em ${url} (não testado: --offline)`);
    else
      try {
        const res = await (opts.fetch ?? fetch)(`${url.replace(/\/$/, "")}/json/version`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        add("ok", `Chrome dedicado acessível em ${url} (fontes: ${[...new Set(cdpNeeded)].join(", ")})`);
      } catch (e) {
        add("fail", `Chrome dedicado em ${url}`, `${errMsg(e)}; abra o Chrome com --remote-debugging-port e entre na conta de leitura`);
      }
  }

  // Buffer
  const buffered = profile.destinations.filter((d) => d.publisher === "buffer");
  if (buffered.length) await bufferChecks(buffered, env, opts, profile.media.strategy !== "none", add);
  else add("ok", "Publicação: todos os destinos são manuais (copiar e colar pelo Telegram)");

  // media tools
  const strategy = profile.media.strategy;
  if (strategy === "render") {
    if (await ffmpegAvailable()) add("ok", "ffmpeg disponível (vídeo renderizado)");
    else add("warn", "ffmpeg não encontrado", "cards de imagem funcionam; vídeo renderizado não (brew install ffmpeg)");
  }
  if (strategy !== "none" && profile.media.downloadVideo) {
    const dl = createDownloaderFromEnv(env);
    if (!dl) add("warn", "Download de vídeo desligado (DOWNLOADER_DISABLED)", "vídeos de terceiros não serão baixados");
    else if (await dl.isAvailable().catch(() => false)) add("ok", "yt-dlp disponível");
    else add("warn", "yt-dlp não encontrado", "sem ele só imagens são usadas (brew install yt-dlp ou defina YTDLP_BIN)");
  }

  // data dir
  try {
    mkdirSync(bundle.dataDir, { recursive: true });
    accessSync(bundle.dataDir, constants.W_OK);
    const probe = join(bundle.dataDir, `.doctor-${process.pid}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    add("ok", `Pasta de dados gravável: ${bundle.dataDir}`);
  } catch (e) {
    add("fail", `Pasta de dados ${bundle.dataDir}`, errMsg(e));
  }
  return checks;
}

async function bufferChecks(buffered: Destination[], env: NodeJS.ProcessEnv, opts: DoctorOptions, hasMedia: boolean, add: (l: Level, label: string, hint?: string) => void): Promise<void> {
  const host = createMediaHostFromEnv(env, opts.fetch);
  const buffer = createBufferFromEnv(env, buffered, host, { fetch: opts.fetch });
  if (!buffer) {
    add("fail", "Buffer: BUFFER_API_KEY", `há destino(s) com publisher "buffer" (${buffered.map((d) => d.platform).join(", ")}); defina a chave ou use "manual"`);
  } else {
    add("ok", "Buffer: BUFFER_API_KEY definida");
    const configured = channelsFromEnv(env, buffered);
    for (const d of buffered) {
      if (configured[d.platform]) {
        add("ok", `Buffer: canal de ${d.platform} definido (modo ${d.mode})`);
      } else if (opts.offline) {
        add("warn", `Buffer: canal de ${d.platform} não definido`, `será descoberto na conta; para fixar, defina ${d.channelEnv ?? `BUFFER_CHANNEL_${d.platform.toUpperCase()}`}`);
      } else {
        try {
          const id = await buffer.resolveChannel(d.platform);
          add("ok", `Buffer: canal de ${d.platform} descoberto na conta (${id}; modo ${d.mode})`);
        } catch (e) {
          add("fail", `Buffer: canal de ${d.platform}`, errMsg(e));
        }
      }
    }
  }
  if (hasMedia) {
    if (host) add("ok", `Hospedagem de mídia para o Buffer: ${host.name}`);
    else add("fail", "Hospedagem de mídia para o Buffer", "defina IMGBB_API_KEY ou as variáveis R2_*; sem URL pública o Buffer recebe só o texto");
  }
}

export async function doctorCommand(ctx: CmdCtx, extra: { fetch?: typeof fetch } = {}): Promise<number> {
  const dir = resolveProfile(ctx.args.profile, ctx.env, ctx.profilesRoot);
  ctx.io.out(`Diagnóstico do perfil em ${dir}${ctx.args.offline ? " (offline: sem chamadas de rede)" : ""}`);
  ctx.io.out();
  const checks = await runChecks(dir, ctx.env, { offline: ctx.args.offline, fetch: extra.fetch });
  for (const c of checks) ctx.io.out(formatCheck(c));
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  ctx.io.out();
  ctx.io.out(fails ? `❌ ${fails} problema(s) a corrigir${warns ? `, ${warns} aviso(s)` : ""}.` : `✅ Tudo certo${warns ? ` (${warns} aviso(s))` : ""}.`);
  return fails ? 1 : 0;
}
