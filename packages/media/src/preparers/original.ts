import type { Draft, Item, PrepareContext, PreparedMedia, Preparer } from "@auto-curator/contracts";
import { describeFile, localizeMedia, type PreparerDeps } from "./localize.js";

/**
 * Uses the source's own media, as is (third party: the approval message asks the human to credit it).
 * Images: local ones kept, the rest downloaded (up to profile.media.maxImages).
 * Video: when profile.media.downloadVideo and a downloader is available, downloaded (media url, then item.sourceUrl);
 * on failure it silently falls back to the images, or to [].
 * A downloaded video replaces the images (platforms do not mix them; images of a video post are only thumbnails).
 */
export class OriginalPreparer implements Preparer {
  readonly strategy = "original" as const;
  constructor(private readonly deps: PreparerDeps) {}

  async prepare(item: Item, _draft: Draft, ctx: PrepareContext): Promise<PreparedMedia[]> {
    const media = await localizeMedia(item, ctx, this.deps, { wantVideo: true });
    const video = media.find((m) => m.type === "video" && m.localPath);
    if (video?.localPath) {
      const d = await describeFile("video", video.localPath);
      return [{
        type: "video", localPath: video.localPath, thirdParty: true,
        ...d, ...(video.durationSec && !d.durationSec ? { durationSec: video.durationSec } : {}),
      }];
    }
    const out: PreparedMedia[] = [];
    for (const m of media) {
      if (m.type !== "image" || !m.localPath) continue;
      const d = await describeFile("image", m.localPath);
      out.push({ type: "image", localPath: m.localPath, thirdParty: true, ...(d.width ? { width: d.width } : {}), ...(d.height ? { height: d.height } : {}) });
    }
    return out;
  }
}
