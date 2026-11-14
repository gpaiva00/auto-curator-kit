import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Item, Logger, Media, MediaDownloader, PrepareContext } from "@auto-curator/contracts";
import { errMsg } from "@auto-curator/contracts";
import { downloadFile } from "../downloader/file.js";
import { ffmpegAvailable, probe } from "../render/ffmpeg.js";

export interface PreparerDeps {
  logger: Logger;
  /** yt-dlp (or any MediaDownloader). Without it, videos are never downloaded. */
  downloader?: MediaDownloader;
  /** Test seam for plain image downloads. */
  fetch?: typeof fetch;
}

export interface LocalizeOptions {
  /** Try to get the video too (only when the caller will use it). */
  wantVideo: boolean;
  /** Index into item.media that is handled first (and therefore wins when maxImages is hit). */
  primaryIndex?: number;
}

const VIDEO_URL_RE = /\.(mp4|mov|webm|m4v)(\?|#|$)/i;

/**
 * Makes item media local. Returns an array parallel to `item.media`: entries that could not be made local
 * (download failed, over maxImages, video not wanted) come back without `localPath`. Never throws.
 */
export async function localizeMedia(item: Item, ctx: PrepareContext, deps: PreparerDeps, opts: LocalizeOptions): Promise<Media[]> {
  const { profile, logger } = ctx;
  const srcDir = path.join(ctx.outDir, "source");
  const out: Media[] = item.media.map((m) => ({ ...m, ...(m.localPath && !existsSync(m.localPath) ? { localPath: undefined } : {}) }));
  const order = item.media.map((_, i) => i);
  if (opts.primaryIndex !== undefined && opts.primaryIndex >= 0 && opts.primaryIndex < order.length) {
    order.splice(order.indexOf(opts.primaryIndex), 1);
    order.unshift(opts.primaryIndex);
  }

  let images = 0;
  let videoDone = false;
  for (const i of order) {
    const m = out[i]!;
    if (m.type === "image") {
      if (images >= profile.media.maxImages) {
        out[i] = { ...m, localPath: undefined };
        continue;
      }
      if (m.localPath) {
        images++;
        continue;
      }
      if (!m.url) continue;
      try {
        const f = await downloadFile(m.url, srcDir, { fetch: deps.fetch });
        out[i] = { ...m, localPath: f.localPath };
        images++;
      } catch (e) {
        logger.warn(`media: imagem nao baixada (${errMsg(e)})`);
      }
      continue;
    }
    // video
    if (videoDone) continue;
    if (m.localPath) {
      videoDone = true;
      continue;
    }
    if (!opts.wantVideo || !profile.media.downloadVideo) continue;
    const got = await downloadVideo(m, item, srcDir, ctx, deps);
    if (got) {
      out[i] = { ...m, localPath: got.localPath, ...(got.durationSec ? { durationSec: got.durationSec } : {}) };
      videoDone = true;
    }
  }
  return out;
}

async function downloadVideo(m: Media, item: Item, dir: string, ctx: PrepareContext, deps: PreparerDeps): Promise<{ localPath: string; durationSec?: number } | undefined> {
  const { logger, profile } = ctx;
  const candidates = [...new Set([m.url, item.sourceUrl ?? undefined].filter((u): u is string => !!u))];
  if (deps.downloader && (await deps.downloader.isAvailable().catch(() => false))) {
    for (const url of candidates) {
      try {
        const files = await deps.downloader.download(url, dir, { maxDurationSec: profile.media.maxVideoSec });
        const v = files.find((f) => f.type === "video");
        if (v) return v;
      } catch (e) {
        logger.warn(`media: video nao baixado de ${safeHost(url)} (${errMsg(e)})`);
      }
    }
  }
  // direct video file (a CDN .mp4 the source gave us): plain fetch, no yt-dlp needed
  if (m.url && VIDEO_URL_RE.test(m.url)) {
    try {
      const f = await downloadFile(m.url, dir, { fetch: deps.fetch, accept: ["video/"], maxBytes: 80 * 1024 * 1024, timeoutMs: 60_000 });
      return { localPath: f.localPath };
    } catch (e) {
      logger.warn(`media: video direto nao baixado (${errMsg(e)})`);
    }
  }
  return undefined;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

/** Width/height (sharp) for images, width/height/duration (ffprobe) for videos. Best effort: {} on any failure. */
export async function describeFile(type: "image" | "video", file: string): Promise<{ width?: number; height?: number; durationSec?: number }> {
  try {
    if (type === "image") {
      const meta = await sharp(file, { failOn: "none" }).metadata();
      return { ...(meta.width ? { width: meta.width } : {}), ...(meta.height ? { height: meta.height } : {}) };
    }
    if (!(await ffmpegAvailable())) return {};
    const p = await probe(file);
    return {
      ...(p.width ? { width: p.width } : {}),
      ...(p.height ? { height: p.height } : {}),
      ...(p.durationSec > 0 ? { durationSec: p.durationSec } : {}),
    };
  } catch {
    return {};
  }
}
