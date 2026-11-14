import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ResolvedBrand } from "./brand.js";
import { CARD_H, CARD_TALL_H, CARD_W, renderCard, type CardVariant } from "./card.js";
import { probe, run } from "./ffmpeg.js";
import { videoFit } from "./fit.js";

export const SPLIT_W = CARD_W;
export const SPLIT_H = CARD_H;
export const SPLIT_TALL_H = CARD_TALL_H;
const MAX_SEC = 60;
/** Tall card: videos with text baked in (headline cards, screenshots) must not lose their edges, so almost any mismatch is shown whole over the blur. */
const TALL_MAX_CROP_LOSS = 0.04;
const FPS = 30;
const RADIUS = 30;
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

export interface SplitInput {
  brand: ResolvedBrand;
  headline: string;
  categoryTag: string;
  sourceCredit: string;
  source: string;
  outFile: string;
  tmpDir: string;
  /** Canvas height: SPLIT_H (4:5, default) or SPLIT_TALL_H (9:16). */
  height?: number;
  /** Platform design of the 9:16 card (see CardVariant). */
  variant?: CardVariant;
}

/**
 * Video card (1080x1350, 4:5 feed): the same card as the image template (header, headline, credit) with the video playing
 * across the whole photo area, rounded on all four corners. The headline shrinks when that gives the video a panel closer to
 * its own shape; whatever mismatch is left is shown whole over a blurred copy (see fit.ts), never cropped.
 */
export async function composeSplit(i: SplitInput): Promise<{ durationSec: number }> {
  await mkdir(i.tmpDir, { recursive: true });
  const info = await probe(i.source);
  if (!info.hasVideo) throw new Error("video_split needs a real video stream");

  const { png: bgPng, layout } = await renderCard({
    brand: i.brand, headline: i.headline, categoryTag: i.categoryTag, sourceCredit: i.sourceCredit, images: [], mode: "video",
    videoSize: { width: info.width, height: info.height }, height: i.height, variant: i.variant,
  });
  const r = layout.photoRect;
  const tall = (i.height ?? SPLIT_H) > SPLIT_H;
  const W = even(r.w), H = even(r.h);

  const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/></svg>`;
  const files = { bg: path.join(i.tmpDir, "split-bg.png"), mask: path.join(i.tmpDir, "split-mask.png") };
  await Promise.all([writeFile(files.bg, bgPng), sharp(Buffer.from(maskSvg)).png().toFile(files.mask)]);

  const dur = Math.min(info.durationSec > 0 ? info.durationSec : MAX_SEC, MAX_SEC);
  const filter = [
    videoFit("1:v", "v0", info, W, H, FPS, "format=yuva420p", tall ? TALL_MAX_CROP_LOSS : undefined),
    `[2:v]format=gray[m]`,
    `[v0][m]alphamerge[vm]`,
    `[0:v][vm]overlay=${Math.round(r.x)}:${Math.round(r.y)},format=yuv420p[out]`,
  ].join(";");
  const loop = (f: string) => ["-loop", "1", "-framerate", String(FPS), "-i", f];
  await run("ffmpeg", [
    "-y", "-v", "error", ...loop(files.bg), "-i", i.source, ...loop(files.mask),
    "-filter_complex", filter, "-map", "[out]", ...(info.hasAudio ? ["-map", "1:a:0"] : []),
    "-t", String(dur),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", String(FPS),
    ...(info.hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ac", "2"] : []),
    "-movflags", "+faststart", i.outFile,
  ]);
  return { durationSec: (await probe(i.outFile)).durationSec };
}
