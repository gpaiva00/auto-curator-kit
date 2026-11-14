import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CARD_H, CARD_TALL_H, CARD_W, renderCard } from "./card.js";
import type { ResolvedBrand } from "./brand.js";
import { extractFrame, ffmpegAvailable, probe } from "./ffmpeg.js";
import { composeSplit, SPLIT_H, SPLIT_TALL_H, SPLIT_W } from "./split.js";
import { safeId } from "./text.js";

export type TemplateName = "card" | "video_split";

/** What a profile's `media.template` resolves to: "auto" = video_split with a video and ffmpeg, else card. */
export function resolveTemplate(configured: string, ctx: { hasVideo: boolean; ffmpeg: boolean }): TemplateName {
  if (configured === "card") return "card";
  if (configured === "video_split") return ctx.hasVideo && ctx.ffmpeg ? "video_split" : "card";
  // "auto" and any unknown name
  return ctx.hasVideo && ctx.ffmpeg ? "video_split" : "card";
}

export interface RenderInput {
  brand: ResolvedBrand;
  headline: string;
  /** Hook line drawn in the accent color above the headline (optional). */
  categoryTag?: string;
  /** Credit footer (empty = none). */
  sourceCredit?: string;
  template: TemplateName;
  /** Local image files, preferred first (card uses up to 2). */
  images: string[];
  /** Local video file (video_split; a still frame feeds the card when there are no images). */
  video?: string;
  /** Also render the 9:16 TikTok variant (video_split only). */
  tiktok?: boolean;
  outDir: string;
  /** File name stem (sanitized). */
  id: string;
}

export interface RenderedFile {
  type: "image" | "video";
  localPath: string;
  platform?: string;
  width: number;
  height: number;
  durationSec?: number;
}

/** Renders the template. Throws when the required media is missing or ffmpeg fails. */
export async function renderMedia(input: RenderInput): Promise<RenderedFile[]> {
  const outDir = path.resolve(input.outDir);
  await mkdir(outDir, { recursive: true });
  const id = safeId(input.id);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "auto-curator-render-"));
  const base = { brand: input.brand, headline: input.headline, categoryTag: input.categoryTag ?? "", sourceCredit: input.sourceCredit ?? "" };
  try {
    if (input.template === "video_split") {
      if (!input.video) throw new Error("video_split needs a local video");
      if (!(await ffmpegAvailable())) throw new Error("ffmpeg not available");
      const out: RenderedFile[] = [];
      const main = path.join(outDir, `${id}.mp4`);
      const r = await composeSplit({ ...base, source: input.video, tmpDir, outFile: main, height: SPLIT_H });
      out.push({ type: "video", localPath: main, width: SPLIT_W, height: SPLIT_H, durationSec: r.durationSec || undefined });
      if (input.tiktok) {
        const tt = path.join(outDir, `${id}-tiktok.mp4`);
        const t = await composeSplit({ ...base, source: input.video, tmpDir, outFile: tt, height: SPLIT_TALL_H, variant: "tiktok" });
        out.push({ type: "video", localPath: tt, platform: "tiktok", width: SPLIT_W, height: SPLIT_TALL_H, durationSec: t.durationSec || undefined });
      }
      return out;
    }

    let images = input.images.slice(0, 2);
    if (images.length === 0 && input.video && (await ffmpegAvailable())) {
      const info = await probe(input.video);
      if (info.hasVideo) {
        const frame = path.join(tmpDir, "frame.png");
        await extractFrame(input.video, frame);
        images = [frame];
      }
    }
    const { png } = await renderCard({ ...base, images, design: "f", centerLogo: !!input.brand.logoPath });
    const out = path.join(outDir, `${id}.png`);
    await writeFile(out, png);
    return [{ type: "image", localPath: out, width: CARD_W, height: CARD_H }];
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export { renderCard, CARD_W, CARD_H, CARD_TALL_H, SPLIT_W, SPLIT_H, SPLIT_TALL_H };
export { sanitizeText } from "./text.js";
export { resolveBrand, type ResolvedBrand } from "./brand.js";
export { ffmpegAvailable } from "./ffmpeg.js";
