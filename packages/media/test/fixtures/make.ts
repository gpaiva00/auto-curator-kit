import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Draft, Item, ProfileConfig } from "@auto-curator/contracts";
import { ProfileConfig as ProfileSchema } from "@auto-curator/contracts";
import { ffmpegAvailable } from "../../src/render/ffmpeg.js";
import { run } from "../../src/render/ffmpeg.js";

/** Solid-color JPEG with a silhouette so crops are easy to judge. */
export async function makeImage(file: string, w: number, h: number, color: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/>` +
    `<circle cx="${w / 2}" cy="${h * 0.38}" r="${w * 0.12}" fill="#000" fill-opacity=".35"/>` +
    `<ellipse cx="${w / 2}" cy="${h * 0.85}" rx="${w * 0.3}" ry="${h * 0.32}" fill="#000" fill-opacity=".35"/></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(file);
  return file;
}

/** Round logo PNG (256x256). */
export async function makeLogo(file: string, color = "#FFC400"): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" rx="56" fill="#111"/><circle cx="128" cy="128" r="70" fill="${color}"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

/** 3 s test-pattern MP4 with audio. Needs ffmpeg. */
export async function makeVideo(file: string, size = "640x360"): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=25:duration=3`, "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
  return file;
}

export const HAS_FFMPEG = await ffmpegAvailable();

export function makeProfile(over: Record<string, unknown> = {}): ProfileConfig {
  return ProfileSchema.parse({
    id: "teste", name: "Perfil Teste", template: "news-card",
    destinations: [{ platform: "instagram", publisher: "manual" }],
    media: { strategy: "render", template: "auto" },
    brand: { name: "Perfil Teste", handle: "@teste", colors: { primary: "#111111", accent: "#E5173F", background: "#FFFFFF", text: "#111111" } },
    ...over,
  });
}

export function makeItem(over: Partial<Item> = {}): Item {
  const now = new Date().toISOString();
  return {
    id: "item-1", dedupeHash: "h", origin: "feed", source: "test", sourceUrl: "https://example.com/post/1", author: "autor",
    title: null, text: "texto", media: [], postedAt: null, capturedAt: now, engagement: {}, extra: {}, status: "curated", score: 80,
    reason: null, draft: null, prepared: [], telegramMsgIds: [], attempts: 0, priority: 0, createdAt: now, updatedAt: now, ...over,
  };
}

export function makeDraft(over: Partial<Draft> = {}): Draft {
  return {
    verdict: "publish", headline: "Criador de conteúdo revela bastidores da maior campanha do ano", body: "corpo", hashtags: [],
    sourceCredit: "Reprodução Instagram @autor", facts: [], riskFlags: [], confidence: 0.9, notes: "", extra: { categoryTag: "Famosos" }, ...over,
  };
}

export async function writeBytes(file: string, bytes: Buffer): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return file;
}
