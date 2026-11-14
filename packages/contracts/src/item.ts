import { z } from "zod";

/**
 * Item lifecycle (one table, one machine, every profile):
 *
 *   new ──► scored ──► curated ──► ready ──► pending_approval ──► approved ──► published
 *    │        │          │          │              │
 *    └────────┴──────────┴──────────┴─► skipped    ├─► rejected
 *                                                  ├─► curated   (🔁 Refazer: back to the Curator)
 *                                                  └─► ready     (✏️/🏷 edit: media re-prepared, re-sent)
 *
 * - `new -> curated` is allowed for manual/profile items (no triage).
 * - `ready` = media prepared (render, original or none); next tick sends it to Telegram.
 */
export const STATUSES = ["new", "scored", "curated", "ready", "pending_approval", "approved", "rejected", "published", "skipped"] as const;
export const Status = z.enum(STATUSES);
export type Status = z.infer<typeof Status>;

export const TRANSITIONS: Record<Status, readonly Status[]> = {
  new: ["scored", "curated", "skipped"],
  scored: ["curated", "skipped"],
  curated: ["ready", "skipped", "curated"],
  ready: ["pending_approval", "skipped", "curated"],
  pending_approval: ["approved", "rejected", "curated", "ready"],
  approved: ["published"],
  rejected: [],
  published: [],
  skipped: [],
};

export const canTransition = (from: Status, to: Status): boolean => TRANSITIONS[from].includes(to);

export const Origin = z.enum(["feed", "profile", "manual"]);
export type Origin = z.infer<typeof Origin>;

/** A piece of media attached to an item: from the source (url) and/or downloaded (localPath). */
export const Media = z.object({
  type: z.enum(["image", "video"]),
  url: z.string().optional(),
  localPath: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSec: z.number().positive().optional(),
});
export type Media = z.infer<typeof Media>;

/** What the prepare step produced for Telegram and the publishers. */
export const PreparedMedia = z.object({
  type: z.enum(["image", "video"]),
  localPath: z.string(),
  /** Optional per-destination variant ("instagram", "tiktok"...). Missing = every destination. */
  platform: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSec: z.number().positive().optional(),
  /** true = third-party media used as-is (the approval message asks the human to credit it). */
  thirdParty: z.boolean().default(false),
});
export type PreparedMedia = z.infer<typeof PreparedMedia>;

/** What a Source returns. The engine turns it into an Item (dedupe by `dedupeKey`). */
export const RawItem = z.object({
  /** Stable key for dedupe, e.g. "x:1234", "rss:<url>". The engine hashes it. */
  dedupeKey: z.string().min(1),
  origin: Origin,
  /** Name of the source that produced it ("NASA", "x-feed"...). */
  source: z.string(),
  sourceUrl: z.string().optional(),
  /** Who posted it (handle without @, outlet name...). */
  author: z.string().default(""),
  title: z.string().optional(),
  text: z.string(),
  media: z.array(Media).default([]),
  postedAt: z.string().optional(),
  engagement: z.object({ likes: z.number().optional(), comments: z.number().optional(), shares: z.number().optional() }).default({}),
  /** Source-specific data, passed to the Curator as-is. */
  extra: z.record(z.unknown()).default({}),
});
export type RawItem = z.input<typeof RawItem>;
export type RawItemParsed = z.infer<typeof RawItem>;

export interface Item {
  id: string;
  dedupeHash: string;
  origin: Origin;
  source: string;
  sourceUrl: string | null;
  author: string;
  title: string | null;
  text: string;
  media: Media[];
  postedAt: string | null;
  capturedAt: string;
  engagement: { likes?: number; comments?: number; shares?: number };
  extra: Record<string, unknown>;
  status: Status;
  /** Triage score 0-100 (null = not triaged). */
  score: number | null;
  /** Last reason (triage reason, skip reason, rejection reason...). */
  reason: string | null;
  draft: import("./draft.js").Draft | null;
  prepared: PreparedMedia[];
  telegramMsgIds: number[];
  attempts: number;
  /** Higher goes first (/furar sets it). */
  priority: number;
  createdAt: string;
  updatedAt: string;
}
