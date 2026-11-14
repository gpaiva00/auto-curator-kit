import sharp from "sharp";

/**
 * How media is placed in a panel of another aspect ratio.
 * - small mismatch: cover-crop (fills the panel, loses a sliver at the edges);
 * - large mismatch: the WHOLE media is shown over a blurred, darkened copy of itself. Sources here are often screenshots
 *   of Instagram posts (outlet header + baked-in caption), where a cover-crop cuts text and faces.
 */
export const MAX_CROP_LOSS = 0.2;

/** Fraction of the source that a cover-crop to w x h throws away (0 = nothing, 0.5 = half). */
export function cropLoss(srcW: number | undefined, srcH: number | undefined, w: number, h: number): number {
  if (!srcW || !srcH) return 0;
  const ratio = srcW / srcH / (w / h);
  return 1 - Math.min(ratio, 1 / ratio);
}
export const needsContain = (srcW: number | undefined, srcH: number | undefined, w: number, h: number, maxLoss = MAX_CROP_LOSS) => cropLoss(srcW, srcH, w, h) > maxLoss;

/** Image file -> JPEG buffer of exactly w x h following the rule above. */
export async function fitImage(file: string, w: number, h: number, quality = 88): Promise<Buffer> {
  const upright = await sharp(file, { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true });
  const { width: sw, height: sh } = upright.info;
  if (!needsContain(sw, sh, w, h)) {
    return sharp(upright.data).resize(w, h, { fit: "cover", position: "attention" }).flatten({ background: "#000000" }).jpeg({ quality }).toBuffer();
  }
  const bg = await sharp(upright.data).resize(w, h, { fit: "cover" }).blur(28).modulate({ brightness: 0.75 }).toBuffer();
  const fg = await sharp(upright.data).resize(w, h, { fit: "inside" }).flatten({ background: "#ffffff" }).toBuffer({ resolveWithObject: true });
  return sharp(bg)
    .composite([{ input: fg.data, left: Math.round((w - fg.info.width) / 2), top: Math.round((h - fg.info.height) / 2) }])
    .flatten({ background: "#000000" })
    .jpeg({ quality })
    .toBuffer();
}

/**
 * ffmpeg filter fragment: `[inL]` (any size) -> `[outL]` exactly W x H, same rule as fitImage.
 * `tail` is appended after setsar/fps (e.g. "format=yuva420p").
 */
export function videoFit(inL: string, outL: string, src: { width?: number; height?: number }, W: number, H: number, fps: number, tail = "", maxLoss = MAX_CROP_LOSS): string {
  const post = `setsar=1,fps=${fps}${tail ? "," + tail : ""}`;
  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  if (!needsContain(src.width, src.height, W, H, maxLoss)) return `[${inL}]${cover},${post}[${outL}]`;
  return [
    `[${inL}]split=2[${outL}_a][${outL}_b]`,
    `[${outL}_a]${cover},boxblur=24:3,eq=brightness=-0.12[${outL}_bg]`,
    `[${outL}_b]scale=${W}:${H}:force_original_aspect_ratio=decrease[${outL}_fg]`,
    `[${outL}_bg][${outL}_fg]overlay=(W-w)/2:(H-h)/2,${post}[${outL}]`,
  ].join(";");
}
