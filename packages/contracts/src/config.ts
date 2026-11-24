import { z } from "zod";
import { PUBLISHER_REQUIRED } from "./errors-pt.js";

// ------------------------------------------------------------------ models.json (LLM routing + budget)

const BaseRole = z
  .object({
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().min(1),
  model: z.string().min(1),
  inputUsdPerM: z.number().nonnegative(),
  outputUsdPerM: z.number().nonnegative(),
  maxTokens: z.number().int().positive().default(4000),
  temperature: z.number().min(0).max(2).default(0.2),
  jsonMode: z.boolean().default(true),
  })
  .strict();
export const RoleConfig = BaseRole.extend({
  /** Tried in order on HTTP 402/429/5xx or network errors. The same monthly cap applies to all. */
  fallback: z.union([BaseRole, z.array(BaseRole)]).optional(),
});
export type RoleConfig = z.infer<typeof RoleConfig>;

export const LLM_ROLES = ["triage", "curator"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

export const ModelsConfig = z
  .object({
    monthlyBudgetBRL: z.number().positive(),
    usdBrl: z.number().positive().default(5.5),
    roles: z.object({ triage: RoleConfig, curator: RoleConfig }).strict(),
  })
  .strict();
export type ModelsConfig = z.infer<typeof ModelsConfig>;

// ------------------------------------------------------------------ profile.json

/** One entry of profile.sources. `type` picks the plugin; the rest is the plugin's own options. */
export const SourceConfig = z
  .object({
    type: z.string().min(1),
    name: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .passthrough();
export type SourceConfig = z.infer<typeof SourceConfig>;

export const Destination = z.object({
  /** "instagram" | "tiktok" | "linkedin" | "x" | "threads" ... (free string, shown capitalised in messages). */
  platform: z.string().min(1),
  /** Id obrigatório do publicador: "manual" (copiar e colar pelo Telegram), "buffer", ou um id de plugins.publishers. */
  publisher: z.string({ required_error: PUBLISHER_REQUIRED, invalid_type_error: PUBLISHER_REQUIRED }).min(1, PUBLISHER_REQUIRED),
  /** Buffer only: draft = lands as a draft (safe default); queue = next free slot; now = immediately. */
  mode: z.enum(["draft", "queue", "now"]).default("draft"),
  /** Buffer only: env var holding the channel id. Default BUFFER_CHANNEL_<PLATFORM>. */
  channelEnv: z.string().optional(),
  /** Posts per day for this destination. */
  dailyCap: z.number().int().positive().default(4),
  /** Minimum minutes between two posts on this channel (0 = no gap). Approved items wait in a local queue. */
  minIntervalMinutes: z.number().int().nonnegative().optional(),
  /** Posting window in the profile timezone, "HH:MM" to "HH:MM" (may wrap midnight). Omit = any time. */
  window: z
    .object({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) })
    .optional(),
  /** URL opened by the "Abrir <plataforma>" button in the manual flow. */
  composeUrl: z.string().url().optional(),
  /** Only post items with this media kind here (e.g. tiktok only takes video). */
  only: z.enum(["any", "image", "video"]).default("any"),
  /** Limite de caracteres do texto final deste destino (corpo + hashtags + crédito). Sem o campo: Threads por Buffer = 500 (padrão de compatibilidade). */
  maxChars: z.number().int().positive().optional(),
  /** Buffer only: teto de chamadas por dia deste canal no contador compartilhado da organização. Sem o campo: 24. */
  bufferDailyCalls: z.number().int().positive().optional(),
}).strict();
export type Destination = z.infer<typeof Destination>;

export const EditorialConfig = z.object({
  /** show = credit the source in the text (news); hide = write as own content (authority / LinkedIn). */
  credit: z.enum(["show", "hide"]).default("show"),
  /** Allowed riskFlags. Unknown flags from the model are kept and treated as forceReview. */
  riskFlags: z.array(z.string()).default(["unverified", "outdated"]),
  /** Flags that force verdict needs_human. */
  forceReview: z.array(z.string()).default(["unverified"]),
  /** Flags that force verdict skip. */
  skip: z.array(z.string()).default([]),
  body: z.object({ minChars: z.number().int().nonnegative().default(20), maxChars: z.number().int().positive().default(2200) }).strict().default({}),
  headline: z.object({ maxChars: z.number().int().positive().default(120) }).strict().default({}),
  hashtags: z.object({ min: z.number().int().nonnegative().default(0), max: z.number().int().nonnegative().default(6) }).strict().default({}),
  firstComment: z.boolean().default(false),
  /** Confidence below this forces needs_human. */
  minConfidence: z.number().min(0).max(1).default(0.6),
  /** Code-level text vetoes (normalized, accent-insensitive). Path relative to the profile dir. */
  vetoFile: z.string().optional(),
  /** Regexes (case-insensitive) that drop an item before any LLM call. */
  blockedPatterns: z.array(z.string()).default([]),
}).strict();
export type EditorialConfig = z.infer<typeof EditorialConfig>;

export const MediaConfig = z.object({
  /** render = branded card/video (media package); original = the source's own media; none = text only. */
  strategy: z.enum(["render", "original", "none"]).default("original"),
  /** Render template name (render strategy only): "card" | "video_split" | "auto". */
  template: z.string().default("auto"),
  maxImages: z.number().int().positive().default(4),
  /** Download source videos (yt-dlp). */
  downloadVideo: z.boolean().default(true),
  maxVideoSec: z.number().int().positive().default(300),
}).strict();
export type MediaConfig = z.infer<typeof MediaConfig>;

export const BrandConfig = z.object({
  name: z.string(),
  handle: z.string().default(""),
  /** Relative to the profile dir. */
  logo: z.string().optional(),
  colors: z
    .object({ primary: z.string().default("#4A22E8"), accent: z.string().default("#FF5A6E"), background: z.string().default("#FFFFFF"), text: z.string().default("#111111") })
    .strict()
    .default({}),
  fontFamily: z.string().default("Inter"),
}).strict();
export type BrandConfig = z.infer<typeof BrandConfig>;

export const PipelineConfig = z.object({
  intervalsMinutes: z
    .object({ ingest: z.number().positive().default(30), pipeline: z.number().positive().default(5), publish: z.number().positive().default(5), metrics: z.number().positive().default(360) })
    .strict()
    .default({}),
  /** Items scoring below this in triage are skipped. */
  triageMinScore: z.number().min(0).max(100).default(60),
  triageBatchSize: z.number().int().positive().default(10),
  /** Items older than this (postedAt or capturedAt) are skipped before triage, and unfinished ones expire. */
  maxItemAgeHours: z.number().positive().default(24),
  /** Items per ingest run per source (highest engagement first). */
  maxNewPerSource: z.number().int().positive().default(15),
  curatorPerTick: z.number().int().positive().default(3),
  maxAttempts: z.number().int().positive().default(3),
  /** Do not curate more while this many wait for a decision. */
  maxPendingApproval: z.number().int().positive().default(5),
  /** Items presented on Telegram per day. */
  dailyApprovalCap: z.number().int().positive().default(8),
  /** Hours between two posts about the same author. 0 = off. */
  subjectCooldownHours: z.number().nonnegative().default(0),
  /** Score at or above which an item bypasses maxPendingApproval. */
  urgentBypassScore: z.number().min(0).max(100).default(90),
}).strict();
export type PipelineConfig = z.infer<typeof PipelineConfig>;

export const RejectReason = z.object({ code: z.string().regex(/^[a-z0-9_]{1,20}$/), label: z.string().min(1) });
export type RejectReason = z.infer<typeof RejectReason>;

export const DEFAULT_REJECT_REASONS: RejectReason[] = [
  { code: "sem_contexto", label: "Sem contexto" },
  { code: "midia_errada", label: "Mídia errada" },
  { code: "inventado", label: "Inventado (não está na fonte)" },
  { code: "sem_valor", label: "Sem valor / tema fraco" },
  { code: "fato_duvidoso", label: "Fato duvidoso" },
  { code: "antigo", label: "Antigo" },
  { code: "fora_nicho", label: "Fora do nicho" },
  { code: "outro", label: "Outro" },
  { code: "sem_motivo", label: "Rejeitar sem motivo" },
];

export const TelegramConfig = z
  .object({
    rejectReasons: z.union([z.literal("default"), z.array(RejectReason).min(1)]).default("default"),
  })
  .strict();
export type TelegramConfig = z.infer<typeof TelegramConfig>;

/** Versão do formato do profile.json que este kit lê. Maior = erro; menor = aviso com a migração. */
export const KIT_PROFILE_VERSION = 1;

export const ProfileConfig = z.object({
  /** Folder-safe id. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  /** Display name used in Telegram messages. */
  name: z.string().min(1),
  /** templates/<template>: prompts and defaults this profile inherits. */
  template: z.string().default("thought-leader"),
  language: z.string().default("pt-BR"),
  timezone: z.string().default("America/Sao_Paulo"),
  sources: z.array(SourceConfig).default([{ type: "manual" }]),
  destinations: z.array(Destination).min(1),
  media: MediaConfig.default({}),
  brand: BrandConfig.optional(),
  editorial: EditorialConfig.default({}),
  pipeline: PipelineConfig.default({}),
  telegram: TelegramConfig.default({}),
  /** "default" = templates/<template>/models.json, or a path relative to the profile dir. */
  models: z.string().default("default"),
  /** Versão do formato deste perfil (ausente = a atual). */
  kitProfileVersion: z.number().int().nonnegative().optional(),
}).strict();
export type ProfileConfig = z.infer<typeof ProfileConfig>;
export type ProfileConfigInput = z.input<typeof ProfileConfig>;

// ------------------------------------------------------------------ templates/<name>/template.json

export const TemplateConfig = z.object({
  name: z.string(),
  description: z.string().default(""),
  /** Keys that must be present in Draft.extra for this template (e.g. ["categoryTag"]). */
  draftExtraRequired: z.array(z.string()).default([]),
  /** Deep-merged under the profile's profile.json (profile wins). */
  defaults: z.record(z.unknown()).default({}),
});
export type TemplateConfig = z.infer<typeof TemplateConfig>;
