/**
 * Plugin and service ports. Packages implement these; the engine wires them.
 * Keep this file dependency-free (types only, plus small error classes).
 */
import type { z } from "zod";
import type { Destination, LlmRole, ProfileConfig, RejectReason, SourceConfig } from "./config.js";
import type { Draft } from "./draft.js";
import type { Item, PreparedMedia, RawItem, Status } from "./item.js";
import type { SettingView } from "./settings.js";

// ------------------------------------------------------------------ basics

export interface Logger {
  debug(msg: string, ...a: unknown[]): void;
  info(msg: string, ...a: unknown[]): void;
  warn(msg: string, ...a: unknown[]): void;
  error(msg: string, ...a: unknown[]): void;
}
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export class KitError extends Error {
  constructor(message: string, readonly code: string = "KIT_ERROR") {
    super(message);
    this.name = "KitError";
  }
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------------ sources

export interface SourceContext {
  now: Date;
  profile: ProfileConfig;
  /** Per-profile data dir (downloads, browser state...). */
  dataDir: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /** Small persistent key/value scoped to this source (cursor, last seen id...). */
  state: { get(key: string): string | undefined; set(key: string, value: string): void };
}

/** Where items come from. `fetch` must be cheap to call and never call an LLM. */
export interface Source {
  readonly type: string;
  readonly name: string;
  fetch(ctx: SourceContext): Promise<RawItem[]>;
  /** Optional: turn a pasted URL or text (/add) into an item. Return undefined if this source does not handle it. */
  fromInput?(input: string, ctx: SourceContext): Promise<RawItem | undefined>;
}

/** Builds a Source from its profile.json entry. Throws KitError on bad options. */
export type SourceFactory = (cfg: SourceConfig, deps: { env: NodeJS.ProcessEnv; logger: Logger }) => Source;

// ------------------------------------------------------------------ media

export interface PrepareContext {
  profile: ProfileConfig;
  /** Absolute profile dir (brand assets are relative to it). */
  profileDir: string;
  /** Where this item's files go (created by the engine). */
  outDir: string;
  logger: Logger;
}

/** Turns an item + draft into the media shown on Telegram and published. Never throws for missing media: return []. */
export interface Preparer {
  readonly strategy: "render" | "original" | "none";
  prepare(item: Item, draft: Draft, ctx: PrepareContext): Promise<PreparedMedia[]>;
}

/** Downloads media behind a public URL (yt-dlp...). Optional everywhere. */
export interface MediaDownloader {
  isAvailable(): Promise<boolean>;
  /** Downloads into outDir and returns local files. Throws KitError("...", "DOWNLOAD_FAILED"). */
  download(url: string, outDir: string, opts?: { maxDurationSec?: number }): Promise<{ type: "image" | "video"; localPath: string; durationSec?: number }[]>;
}

// ------------------------------------------------------------------ publishing

export interface PublishRequest {
  item: Item;
  destination: Destination;
  /** Final text (composeText of the draft). */
  text: string;
  firstComment?: string;
  /** Prepared media for this destination. */
  media: PreparedMedia[];
}

export interface PublishResult {
  externalId: string;
  mode: "draft" | "queue" | "now";
  /** When the provider reports a scheduled time. */
  scheduledAt?: string;
  /** Media that could not be attached (e.g. no MediaHost). */
  droppedMedia?: number;
}

export class PublishError extends KitError {
  constructor(message: string, readonly opts: { retryAfterSec?: number; fatal?: boolean } = {}) {
    super(message, "PUBLISH");
    this.name = "PublishError";
  }
}

/** Schedules/publishes on one platform. Only "buffer" today; "manual" is handled by the engine + Telegram. */
export interface Publisher {
  readonly name: string;
  publish(req: PublishRequest): Promise<PublishResult>;
  /** Optional: posts scheduled in the provider (for /agenda). */
  listScheduled?(): Promise<{ externalId: string; platform: string; text: string; scheduledAt?: string }[]>;
}

/** Turns a local file into a public URL a provider can fetch (R2, imgbb...). */
export interface MediaHost {
  readonly name: string;
  supports(kind: "image" | "video"): boolean;
  upload(localPath: string): Promise<string>;
}

// ------------------------------------------------------------------ LLM + prompts

export interface JsonRequest<T> {
  role: LlmRole;
  system: string;
  user: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Label for usage accounting (e.g. item id). */
  label?: string;
}

export interface LlmPort {
  json<T>(req: JsonRequest<T>): Promise<{ value: T; costBRL: number; model: string }>;
}

export interface PromptProvider {
  /** Full system prompt for a role (template prompt, profile override, plus style guide when present). */
  get(role: LlmRole): { text: string; version: string };
}

// ------------------------------------------------------------------ store (implemented by engine, used by telegram)

export interface Publication {
  id: string;
  itemId: string;
  platform: string;
  publisher: string;
  externalId: string | null;
  mode: string | null;
  status: "scheduled" | "published" | "failed" | "manual";
  scheduledAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface StorePort {
  get(id: string): Item | undefined;
  list(status: Status | Status[], limit?: number): Item[];
  count(status: Status | Status[]): number;
  transition(id: string, to: Status, note?: string): Item;
  setDraft(id: string, draft: Draft): void;
  setTelegramMsgs(id: string, ids: number[]): void;
  setPriority(id: string, priority: number): void;
  recordApproval(id: string, action: "approve" | "reject" | "edit_body" | "edit_headline" | "regenerate" | "published_manual", reason?: string): void;
  listPublications(opts?: { status?: Publication["status"][]; limit?: number }): Publication[];
  kvGet(k: string): string | undefined;
  kvSet(k: string, v: string): void;
  kvDel(k: string): void;
  monthSpendBRL(): number;
  presentedToday(): number;
}

// ------------------------------------------------------------------ approval (engine) <-> notifier (telegram)

export interface DestinationOutcome {
  platform: string;
  /** buffer = sent to Buffer; manual = human must post; failed = Buffer failed, fell back to manual. */
  kind: "buffer" | "manual" | "failed";
  mode?: "draft" | "queue" | "now";
  scheduledAt?: string;
  error?: string;
  droppedMedia?: number;
}

/** What the Telegram bot can ask the application to do. Implemented by the engine. */
export interface BotActions {
  /** /add: URL or text. Returns the new item or why not. */
  addManual(input: string): Promise<{ item?: Item; error?: string }>;
  /** Runs the pipeline once (triage -> curate -> prepare -> send for approval). */
  runPipeline(): Promise<void>;
  /** /ler: runs every source once. Returns a one-line summary (pt-BR). */
  ingestNow(): Promise<string>;
  /** 🔁 Refazer: back to the Curator with an optional instruction, then re-sent. */
  regenerate(id: string, feedback?: string): Promise<void>;
  /** After ✏️/🏷 edits: re-prepare media (render) and re-send for approval. */
  reprepare(id: string): Promise<void>;
  /** ✅ Aprovar: moves to approved and publishes to each destination. */
  approve(id: string): Promise<DestinationOutcome[]>;
  /** ❌ Rejeitar with a reason code. */
  reject(id: string, reasonCode: string): Promise<void>;
  /** ✅ Publiquei (manual flow). */
  markPublished(id: string, platform: string): Promise<void>;
  /** /agenda: scheduled posts (Buffer) */
  agenda(): Promise<{ platform: string; label: string; scheduledAt?: string }[]>;
  isPaused(): boolean;
  setPaused(p: boolean): void;
  status(): StatusSnapshot;
  /** /config: the settings Telegram can change, with their current values. */
  settings(): SettingView[];
  /** /definir: changes one setting in profile.json (validated, rolled back if invalid). Throws with the reason. */
  setSetting(key: string, raw: string): Promise<SettingView>;
}

export interface StatusSnapshot {
  profileName: string;
  paused: boolean;
  counts: Partial<Record<Status, number>>;
  spendBRL: number;
  budgetBRL: number;
  presentedToday: number;
  dailyApprovalCap: number;
  /** Why generation is held right now, if it is (pt-BR). */
  gate?: string;
}

/** Notifier port: the engine calls it; Telegram implements it. */
export interface Notifier {
  /** Sends media + approval card. Returns the message ids (to delete them later). */
  sendApproval(item: Item): Promise<number[]>;
  /** Free text notice (skips, failures, schedules). */
  notify(text: string): Promise<void>;
}

export interface ApprovalUiConfig {
  profileName: string;
  credit: "show" | "hide";
  destinations: Destination[];
  rejectReasons: RejectReason[];
  timezone: string;
}
