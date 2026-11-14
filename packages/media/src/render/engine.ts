import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { fitImage } from "./fit.js";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadFonts, type SatoriFont } from "./fonts.js";
import { breakLongTokens, truncateChars } from "./text.js";

export interface Node {
  type: string;
  props: { style?: Record<string, unknown>; children?: unknown; [k: string]: unknown };
}

/** Tiny hyperscript helper. Every element is display:flex (satori requirement for multi-child nodes). */
export function h(type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node {
  return { type, props: { ...extra, style: { display: "flex", ...style }, children } };
}

export function img(src: string, width: number, height: number, style: Record<string, unknown> = {}): Node {
  return { type: "img", props: { src, width, height, style: { width, height, ...style } } };
}

export async function toSvg(node: Node, width: number, height: number | undefined, fonts: SatoriFont[]): Promise<string> {
  return satori(node as never, { width, ...(height ? { height } : {}), fonts: fonts as never });
}

/** Rasterizes svg to PNG. Background is transparent unless a color is given. */
export function svgToPng(svg: string, background?: string): Buffer {
  const r = new Resvg(svg, { ...(background ? { background } : {}), font: { loadSystemFonts: false } });
  return Buffer.from(r.render().asPng());
}

function svgHeight(svg: string): number {
  const m = /<svg[^>]*\sheight="([\d.]+)"/.exec(svg);
  return m ? Number(m[1]) : 0;
}

export interface FitOptions {
  width: number;
  sizes: number[]; // descending
  maxLines: number;
  lineHeight: number;
  weight?: 500 | 700 | 800;
  letterSpacing?: number;
  fonts: SatoriFont[];
  fontName: string;
}

export interface FitResult {
  text: string;
  fontSize: number;
  height: number;
  lines: number;
  truncated: boolean;
}

/**
 * Finds the largest font size at which the headline fits in maxLines, measuring with satori itself
 * (same engine as the final render). If it doesn't fit even at the smallest size, drops trailing
 * words and appends an ellipsis. Result: never overflows.
 */
export async function fitHeadline(raw: string, o: FitOptions): Promise<FitResult> {
  const text0 = breakLongTokens(raw);
  const measure = async (text: string, size: number) => {
    const svg = await toSvg(
      h("div", {
        width: o.width, fontFamily: o.fontName, fontSize: size, fontWeight: o.weight ?? 800,
        lineHeight: o.lineHeight, letterSpacing: o.letterSpacing ?? 0,
      }, text),
      o.width, undefined, o.fonts,
    );
    const height = svgHeight(svg);
    return { height, lines: Math.max(1, Math.round(height / (size * o.lineHeight))) };
  };
  for (const size of o.sizes) {
    const m = await measure(text0, size);
    if (m.lines <= o.maxLines) return { text: text0, fontSize: size, ...m, truncated: false };
  }
  const size = o.sizes[o.sizes.length - 1]!;
  const words = text0.split(" ");
  let lo = 1, hi = words.length - 1, best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cand = words.slice(0, mid).join(" ").replace(/[,;:\s]+$/, "") + "…";
    const m = await measure(cand, size);
    if (m.lines <= o.maxLines) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const text = words.slice(0, best).join(" ").replace(/[,;:\s]+$/, "") + "…";
  const m = await measure(text, size);
  return { text, fontSize: size, ...m, truncated: true };
}

/** Fits an image file into exactly w x h (cover-crop, or whole image over a blurred backdrop when the crop would be large) as a data URI (JPEG). */
export async function coverDataUri(file: string, w: number, h_: number): Promise<string> {
  const buf = await fitImage(file, w, h_);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

export function bufferToDataUri(buf: Buffer, mime = "image/png"): string {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Logo as square PNG data URI, or null when missing/unreadable (callers draw a monogram). */
export async function logoDataUri(logoPath: string | undefined, size: number): Promise<string | null> {
  if (!logoPath) return null;
  try {
    const abs = path.resolve(logoPath);
    const data = await readFile(abs);
    const buf = await sharp(data)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return bufferToDataUri(buf);
  } catch {
    return null;
  }
}

/** Small round-badge mark: `<logo>-mark.png` next to the logo when present (a wordmark is unreadable at 84px), else the logo. */
export async function markDataUri(logoPath: string | undefined, size: number): Promise<string | null> {
  if (!logoPath) return null;
  const ext = path.extname(logoPath);
  const mark = ext ? logoPath.slice(0, -ext.length) + "-mark" + ext : logoPath + "-mark";
  return (await logoDataUri(mark, size)) ?? (await logoDataUri(logoPath, size));
}

export function monogram(name: string, size: number, bg: string, fg: string, fontName: string, radius: number): Node {
  const letter = (name.trim()[0] ?? "A").toUpperCase();
  return h("div", {
    width: size, height: size, borderRadius: radius, backgroundColor: bg, color: fg,
    alignItems: "center", justifyContent: "center", fontFamily: fontName, fontWeight: 800, fontSize: Math.round(size * 0.5),
  }, letter);
}

export async function logoNode(logoPath: string | undefined, size: number, radius: number, brand: { name: string; primary: string; fg: string }, fontName: string): Promise<Node> {
  const uri = await logoDataUri(logoPath, size * 2);
  if (!uri) return monogram(brand.name, size, brand.primary, brand.fg, fontName, radius);
  return img(uri, size, size, { borderRadius: radius });
}

export { truncateChars };
