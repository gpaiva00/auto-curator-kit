import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fitHeadline } from "../src/render/engine.js";
import { loadFonts } from "../src/render/fonts.js";
import { cropLoss, fitImage, needsContain } from "../src/render/fit.js";
import { run, probe } from "../src/render/ffmpeg.js";
import { renderCard, renderMedia, resolveBrand, resolveTemplate, sanitizeText, type ResolvedBrand } from "../src/index.js";
import { HAS_FFMPEG, makeImage, makeLogo, makeProfile, makeVideo } from "./fixtures/make.js";

let dir: string;
let photo: string;
let photo2: string;
let logo: string;
let video: string;
const brand: ResolvedBrand = { name: "PERFIL", handle: "@perfil", colors: { primary: "#4A22E8", accent: "#E5173F", background: "#FFFFFF", text: "#111111" }, fontFamily: "Inter" };
const LONG = "🚨 VEJA: criador de conteúdo paulistano revela bastidores da maior campanha publicitária do ano, confirma parceria com marcas internacionais e promete novidades para os seguidores já na próxima semana, segundo publicação";

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "media-render-"));
  photo = await makeImage(path.join(dir, "a.jpg"), 1200, 800, "#2266cc");
  photo2 = await makeImage(path.join(dir, "b.jpg"), 800, 1000, "#22aa66");
  logo = await makeLogo(path.join(dir, "logo.png"));
  if (HAS_FFMPEG) video = await makeVideo(path.join(dir, "v.mp4"));
}, 60_000);
afterAll(() => rm(dir, { recursive: true, force: true }));

const dims = async (png: Buffer) => {
  const m = await sharp(png).metadata();
  return [m.width, m.height, m.format];
};
/** True when some pixel in the rect is within `tol` of the color. */
async function hasColor(png: Buffer, rect: { x: number; y: number; w: number; h: number }, hex: string, tol = 40): Promise<boolean> {
  const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const { data, info } = await sharp(png).extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    if (want.every((v, k) => Math.abs(data[i + k]! - v) < tol)) return true;
  }
  return false;
}

describe("text", () => {
  it("strips emoji, keeps pt-BR diacritics", () => {
    expect(sanitizeText("🚨 VEJA: ação já! 👩‍👩‍👧 São Paulo ✅")).toBe("VEJA: ação já! São Paulo");
  });
});

describe("text fitting", () => {
  it("never overflows 4 lines even with a very long headline", async () => {
    const { fonts, name } = loadFonts("Inter");
    const fit = await fitHeadline(sanitizeText(LONG.repeat(3)), { width: 952, sizes: [80, 52], maxLines: 4, lineHeight: 1.12, fonts, fontName: name });
    expect(fit.lines).toBeLessThanOrEqual(4);
    expect(fit.truncated).toBe(true);
    expect(fit.text.endsWith("…")).toBe(true);
  });
  it("short headline keeps the largest size, untruncated", async () => {
    const { fonts, name } = loadFonts("Inter");
    const fit = await fitHeadline("Curto", { width: 952, sizes: [76, 50], maxLines: 4, lineHeight: 1.12, fonts, fontName: name });
    expect(fit.fontSize).toBe(76);
    expect(fit.truncated).toBe(false);
  });
  it("handles unbroken giant tokens", async () => {
    const { layout } = await renderCard({ brand, headline: "A".repeat(400), categoryTag: "x", sourceCredit: "c", images: [photo] });
    expect(layout.headlineLines).toBeLessThanOrEqual(4);
    expect(layout.photoHeight).toBeGreaterThanOrEqual(420);
  });
});

describe("card (layout f)", () => {
  it("is a 1080x1350 PNG: white block on top, photo fills the rest edge to edge", async () => {
    const { png, layout } = await renderCard({ brand, headline: LONG, categoryTag: "Famosos", sourceCredit: "c", images: [photo], design: "f" });
    expect(await dims(png)).toEqual([1080, 1350, "png"]);
    expect(layout.photoRect).toMatchObject({ x: 0, w: 1080 });
    expect(layout.photoRect.y + layout.photoRect.h).toBe(1350);
    expect(layout.photoRect.y).toBeGreaterThan(0);
    expect(layout.headlineLines).toBeLessThanOrEqual(4);
  });
  it("applies brand colors: hook in accent, background behind the text block", async () => {
    const { png } = await renderCard({ brand, headline: "Título", categoryTag: "Famosos", sourceCredit: "", images: [photo], design: "f" });
    expect(await hasColor(png, { x: 40, y: 40, w: 1000, h: 140 }, "#E5173F")).toBe(true);
    const { data } = await sharp(png).extract({ left: 1060, top: 10, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    expect([...data].slice(0, 3)).toEqual([255, 255, 255]);
    // another brand: accent changes
    const other = await renderCard({ brand: { ...brand, colors: { ...brand.colors, accent: "#00AA55" } }, headline: "Título", categoryTag: "Famosos", sourceCredit: "", images: [photo], design: "f" });
    expect(await hasColor(other.png, { x: 40, y: 40, w: 1000, h: 140 }, "#00AA55")).toBe(true);
    expect(await hasColor(other.png, { x: 40, y: 40, w: 1000, h: 140 }, "#E5173F")).toBe(false);
  });
  it("without photos paints the panel with the primary color", async () => {
    const { png, layout } = await renderCard({ brand, headline: "Título", categoryTag: "", sourceCredit: "", images: [], design: "f" });
    expect(await dims(png)).toEqual([1080, 1350, "png"]);
    const y = layout.photoRect.y + 30;
    const { data } = await sharp(png).extract({ left: 20, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    expect([...data].slice(0, 3)).toEqual([0x4a, 0x22, 0xe8]);
  });
  it("logo is optional: monogram or logo on the seam of two photos, no logo = plain seam", async () => {
    const seam = async (b: ResolvedBrand, centerLogo: boolean) => {
      const { png, layout } = await renderCard({ brand: b, headline: "Título", categoryTag: "X", sourceCredit: "", images: [photo, photo2], design: "f", centerLogo });
      const cy = Math.round(layout.photoRect.y + layout.photoRect.h / 2) - 62; // inside the badge, above the monogram letter
      const { data } = await sharp(png).extract({ left: 540, top: cy, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
      return [...data].slice(0, 3);
    };
    const plain = await seam(brand, false);
    expect(plain[0]).toBeGreaterThan(200); // white gap
    const withLogo = await seam({ ...brand, logoPath: logo }, true);
    expect(withLogo).not.toEqual(plain);
    const missing = await seam({ ...brand, logoPath: path.join(dir, "nope.png") }, true); // monogram fallback, no throw
    expect(missing).toEqual([0x4a, 0x22, 0xe8]);
  });
  it("renders a 1080x1080 square", async () => {
    const { png } = await renderCard({ brand, headline: "Título", categoryTag: "X", sourceCredit: "c", images: [photo], design: "f", height: 1080 });
    expect(await dims(png)).toEqual([1080, 1080, "png"]);
  });
});

describe("brand + template resolution", () => {
  it("uses profile.name and default colors when the profile has no brand", () => {
    const p = makeProfile({ brand: undefined, name: "Meu Perfil" });
    const b = resolveBrand(p, "/profiles/x");
    expect(b.name).toBe("Meu Perfil");
    expect(b.colors.primary).toBe("#4A22E8");
    expect(b.logoPath).toBeUndefined();
  });
  it("resolves the logo relative to profileDir", () => {
    const b = resolveBrand(makeProfile({ brand: { name: "N", logo: "brand/logo.png" } }), "/profiles/x");
    expect(b.logoPath).toBe("/profiles/x/brand/logo.png");
  });
  it("auto = video_split only with a video AND ffmpeg", () => {
    expect(resolveTemplate("auto", { hasVideo: true, ffmpeg: true })).toBe("video_split");
    expect(resolveTemplate("auto", { hasVideo: true, ffmpeg: false })).toBe("card");
    expect(resolveTemplate("auto", { hasVideo: false, ffmpeg: true })).toBe("card");
    expect(resolveTemplate("card", { hasVideo: true, ffmpeg: true })).toBe("card");
    expect(resolveTemplate("video_split", { hasVideo: false, ffmpeg: true })).toBe("card");
  });
});

describe("renderMedia", () => {
  it("card: writes only inside outDir and sanitizes the id", async () => {
    const out = path.join(dir, "safe");
    const files = await renderMedia({ brand, headline: "T", template: "card", images: [photo], outDir: out, id: "../../evil/x" });
    expect(path.dirname(files[0]!.localPath)).toBe(out);
    expect(files[0]).toMatchObject({ type: "image", width: 1080, height: 1350 });
  });
  it("video_split without a video throws", async () => {
    await expect(renderMedia({ brand, headline: "T", template: "video_split", images: [], outDir: dir, id: "x" })).rejects.toThrow();
  });
  it.skipIf(!HAS_FFMPEG)("card from a video: a frame is extracted", async () => {
    const files = await renderMedia({ brand, headline: "T", template: "card", images: [], video, outDir: path.join(dir, "frame"), id: "f" });
    expect(files[0]!.type).toBe("image");
  }, 60_000);
  it.skipIf(!HAS_FFMPEG)("video_split: 1080x1350 h264+aac, the video really moves; tiktok variant is 1080x1920", async () => {
    const files = await renderMedia({ brand, headline: "Título do vídeo", categoryTag: "X", sourceCredit: "c", template: "video_split", images: [], video, tiktok: true, outDir: path.join(dir, "split"), id: "s" });
    expect(files.map((f) => [f.platform, f.width, f.height])).toEqual([[undefined, 1080, 1350], ["tiktok", 1080, 1920]]);
    const main = files[0]!;
    const out = JSON.parse(await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", main.localPath])) as { streams: Record<string, unknown>[] };
    const v = out.streams.find((s) => s.codec_type === "video")!;
    expect([v.width, v.height, v.codec_name, v.pix_fmt]).toEqual([1080, 1350, "h264", "yuv420p"]);
    expect(out.streams.some((s) => s.codec_type === "audio")).toBe(true);
    expect(main.durationSec).toBeGreaterThan(2.5);
    const tt = await probe(files[1]!.localPath);
    expect([tt.width, tt.height]).toEqual([1080, 1920]);
    // header identical across time, video area differs
    const grab = async (t: number) => {
      const f = path.join(dir, `split-${t}.png`);
      await run("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", main.localPath, "-frames:v", "1", f]);
      return f;
    };
    const [a, b] = [await grab(0.5), await grab(2)];
    const crop = async (f: string, header: boolean) => sharp(f).extract(header ? { left: 40, top: 40, width: 600, height: 100 } : { left: 300, top: 800, width: 400, height: 300 }).raw().toBuffer();
    const meanDiff = (x: Buffer, y: Buffer) => { let t = 0; for (let k = 0; k < x.length; k++) t += Math.abs(x[k]! - y[k]!); return t / x.length; };
    expect(meanDiff(await crop(a, true), await crop(b, true))).toBeLessThan(3);
    expect(meanDiff(await crop(a, false), await crop(b, false))).toBeGreaterThan(10);
  }, 120_000);
});

describe("fit (crop vs whole media)", () => {
  it("cropLoss is 0 for the same aspect and grows with the mismatch", () => {
    expect(cropLoss(1080, 1920, 540, 960)).toBeCloseTo(0, 5);
    expect(needsContain(1080, 1350, 490, 840)).toBe(true);
    expect(needsContain(1080, 1920, 490, 840)).toBe(false);
    expect(needsContain(undefined, undefined, 490, 840)).toBe(false);
  });
  it("fitImage returns exactly w x h and keeps the whole picture when the crop would be large", async () => {
    const wide = path.join(dir, "bands.png");
    await sharp({ create: { width: 900, height: 300, channels: 3, background: "#00ff00" } })
      .composite([
        { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: "#ff0000" } }).png().toBuffer(), left: 0, top: 0 },
        { input: await sharp({ create: { width: 300, height: 300, channels: 3, background: "#0000ff" } }).png().toBuffer(), left: 600, top: 0 },
      ]).png().toFile(wide);
    const buf = await fitImage(wide, 300, 600);
    const meta = await sharp(buf).metadata();
    expect([meta.width, meta.height]).toEqual([300, 600]);
    const px = async (x: number, y: number) => [...(await sharp(buf).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];
    expect((await px(5, 300))[0]).toBeGreaterThan(200);
    expect((await px(294, 300))[2]).toBeGreaterThan(200);
  });
});
