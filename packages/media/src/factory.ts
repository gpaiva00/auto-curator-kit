import type { Logger, MediaDownloader, Preparer, ProfileConfig } from "@auto-curator/contracts";
import { YtDlpDownloader } from "./downloader/ytdlp.js";
import { NonePreparer } from "./preparers/none.js";
import { OriginalPreparer } from "./preparers/original.js";
import { RenderPreparer, type RenderPreparerDeps } from "./preparers/render.js";

export interface PreparerFactoryDeps {
  logger: Logger;
  /** Optional: without it videos are not downloaded. */
  downloader?: MediaDownloader;
  /** Test seams. */
  fetch?: typeof fetch;
  ffmpegAvailable?: RenderPreparerDeps["ffmpegAvailable"];
  renderer?: RenderPreparerDeps["renderer"];
}

/** Picks the Preparer for profile.media.strategy: render | original | none. */
export function createPreparer(profile: Pick<ProfileConfig, "media">, deps: PreparerFactoryDeps): Preparer {
  switch (profile.media.strategy) {
    case "none":
      return new NonePreparer();
    case "render":
      return new RenderPreparer(deps);
    default:
      return new OriginalPreparer(deps);
  }
}

const truthy = (v: string | undefined): boolean => !!v && /^(1|true|yes|on)$/i.test(v.trim());

/**
 * yt-dlp downloader from the environment. DOWNLOADER_DISABLED=1 returns undefined (no downloads at all).
 * Optional: YTDLP_BIN, FFPROBE_BIN, YTDLP_COOKIES_FILE, DOWNLOADER_MAX_MB.
 */
export function createDownloaderFromEnv(env: NodeJS.ProcessEnv = process.env): MediaDownloader | undefined {
  if (truthy(env.DOWNLOADER_DISABLED)) return undefined;
  const maxMb = Number(env.DOWNLOADER_MAX_MB);
  return new YtDlpDownloader({
    ...(env.YTDLP_BIN ? { bin: env.YTDLP_BIN } : {}),
    ...(env.FFPROBE_BIN ? { ffprobeBin: env.FFPROBE_BIN } : {}),
    ...(env.YTDLP_COOKIES_FILE ? { cookiesFile: env.YTDLP_COOKIES_FILE } : {}),
    ...(Number.isFinite(maxMb) && maxMb > 0 ? { maxFileSizeMb: maxMb } : {}),
  });
}
