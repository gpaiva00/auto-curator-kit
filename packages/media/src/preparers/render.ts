import path from "node:path";
import type { Draft, Item, PrepareContext, PreparedMedia, Preparer } from "@auto-curator/contracts";
import { errMsg } from "@auto-curator/contracts";
import { resolveBrand } from "../render/brand.js";
import { ffmpegAvailable } from "../render/ffmpeg.js";
import { renderMedia, resolveTemplate, type RenderInput } from "../render/index.js";
import { OriginalPreparer } from "./original.js";
import { localizeMedia, type PreparerDeps } from "./localize.js";

export interface RenderPreparerDeps extends PreparerDeps {
  /** Test seams. */
  ffmpegAvailable?: () => Promise<boolean>;
  renderer?: typeof renderMedia;
}

/** Reads draft.extra.mediaPlan.primaryMediaIndex and draft.extra.categoryTag (both optional). */
export function readDraftExtra(draft: Draft): { categoryTag: string; primaryMediaIndex: number } {
  const extra = draft.extra ?? {};
  const tag = typeof extra.categoryTag === "string" ? extra.categoryTag : "";
  const plan = extra.mediaPlan;
  const idx = plan && typeof plan === "object" ? (plan as Record<string, unknown>).primaryMediaIndex : undefined;
  return { categoryTag: tag, primaryMediaIndex: typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : 0 };
}

/**
 * Branded render: card (PNG 1080x1350) or video_split (MP4 1080x1350, plus a 9:16 TikTok variant when a destination is tiktok).
 * Source media are made local first. If rendering fails for any reason, falls back to the original preparer (and warns).
 */
export class RenderPreparer implements Preparer {
  readonly strategy = "render" as const;
  private readonly original: OriginalPreparer;

  constructor(private readonly deps: RenderPreparerDeps) {
    this.original = new OriginalPreparer(deps);
  }

  async prepare(item: Item, draft: Draft, ctx: PrepareContext): Promise<PreparedMedia[]> {
    let localItem = item;
    try {
      const { categoryTag, primaryMediaIndex } = readDraftExtra(draft);
      const hasFfmpeg = await (this.deps.ffmpegAvailable ?? ffmpegAvailable)();
      const configured = ctx.profile.media.template;
      const hasRemoteVideo = item.media.some((m) => m.type === "video");
      const hasImages = item.media.some((m) => m.type === "image");
      // video is only worth downloading when the template can use it (or when it is the only media for a card frame)
      const wantVideo = hasFfmpeg && hasRemoteVideo && (configured !== "card" || !hasImages);
      const media = await localizeMedia(item, ctx, this.deps, { wantVideo, primaryIndex: primaryMediaIndex });
      localItem = { ...item, media };

      const video = media.find((m) => m.type === "video" && m.localPath)?.localPath;
      const images = media.filter((m) => m.type === "image" && m.localPath).map((m) => m.localPath!);
      // primary media first: when the primary is an image it already leads (localize handled it first); keep list order otherwise
      const primary = media[primaryMediaIndex];
      const ordered = primary?.type === "image" && primary.localPath ? [primary.localPath, ...images.filter((p) => p !== primary.localPath)] : images;

      const template = resolveTemplate(configured, { hasVideo: !!video, ffmpeg: hasFfmpeg });
      const input: RenderInput = {
        brand: resolveBrand(ctx.profile, ctx.profileDir),
        headline: draft.headline,
        categoryTag,
        sourceCredit: ctx.profile.editorial.credit === "show" ? (draft.sourceCredit ?? "") : "",
        template,
        images: ordered,
        ...(video ? { video } : {}),
        tiktok: ctx.profile.destinations.some((d) => d.platform.toLowerCase() === "tiktok"),
        outDir: path.join(ctx.outDir, "render"),
        id: item.id,
      };
      const files = await (this.deps.renderer ?? renderMedia)(input);
      if (files.length === 0) throw new Error("renderer returned no files");
      return files.map((f) => ({
        type: f.type, localPath: f.localPath, width: f.width, height: f.height, thirdParty: false,
        ...(f.platform ? { platform: f.platform } : {}), ...(f.durationSec ? { durationSec: f.durationSec } : {}),
      }));
    } catch (e) {
      ctx.logger.warn(`render falhou para ${item.id}, usando midia original: ${errMsg(e)}`);
      return this.original.prepare(localItem, draft, ctx);
    }
  }
}
