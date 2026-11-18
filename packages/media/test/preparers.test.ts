import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { silentLogger, type Logger, type MediaDownloader, type PrepareContext } from "@auto-curator/contracts";
import { DownloaderError, NonePreparer, OriginalPreparer, RenderPreparer, type RenderInput } from "../src/index.js";
import { HAS_FFMPEG, makeDraft, makeImage, makeItem, makeProfile, makeVideo } from "./fixtures/make.js";

let dir: string;
let n = 0;
let photo: string;
let photo2: string;
let video: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "media-prep-"));
  photo = await makeImage(path.join(dir, "a.jpg"), 1200, 800, "#2266cc");
  photo2 = await makeImage(path.join(dir, "b.jpg"), 800, 1000, "#22aa66");
  if (HAS_FFMPEG) video = await makeVideo(path.join(dir, "v.mp4"));
}, 60_000);
afterAll(() => rm(dir, { recursive: true, force: true }));

const spyLogger = (): Logger & { warn: ReturnType<typeof vi.fn> } => ({ ...silentLogger, warn: vi.fn() });
function ctx(profile = makeProfile(), logger: Logger = silentLogger): PrepareContext {
  return { profile, profileDir: dir, outDir: path.join(dir, `out-${n++}`), logger };
}
async function png(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: "#ff0000" } }).png().toBuffer();
}
const imageFetch = (calls: string[] = []): typeof fetch =>
  (async (url: string) => {
    calls.push(String(url));
    return new Response(new Uint8Array(await png()), { headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch;

function fakeDownloader(over: Partial<MediaDownloader> & { calls?: string[] } = {}): MediaDownloader & { calls: string[] } {
  const calls = over.calls ?? [];
  return {
    calls,
    isAvailable: over.isAvailable ?? (async () => true),
    download: over.download ?? (async (url, outDir) => {
      calls.push(url);
      const f = path.join(outDir, "dl.mp4");
      await writeFile(f, "x").catch(async () => { await (await import("node:fs/promises")).mkdir(outDir, { recursive: true }); await writeFile(f, "x"); });
      return [{ type: "video" as const, localPath: f, durationSec: 7 }];
    }),
  };
}

describe("none preparer", () => {
  it("returns []", async () => {
    const p = new NonePreparer();
    expect(p.strategy).toBe("none");
    expect(await p.prepare(makeItem({ media: [{ type: "image", localPath: photo }] }), makeDraft(), ctx())).toEqual([]);
  });
});

describe("original preparer", () => {
  it("keeps local images and marks them thirdParty with dimensions", async () => {
    const out = await new OriginalPreparer({ logger: silentLogger }).prepare(makeItem({ media: [{ type: "image", localPath: photo }, { type: "image", localPath: photo2 }] }), makeDraft(), ctx());
    expect(out).toEqual([
      { type: "image", localPath: photo, width: 1200, height: 800, thirdParty: true },
      { type: "image", localPath: photo2, width: 800, height: 1000, thirdParty: true },
    ]);
  });

  it("downloads remote images up to profile.media.maxImages (fake fetch)", async () => {
    const calls: string[] = [];
    const profile = makeProfile({ media: { strategy: "original", maxImages: 2 } });
    const item = makeItem({ media: [1, 2, 3, 4].map((i) => ({ type: "image" as const, url: `https://cdn.example.com/${i}.png` })) });
    const out = await new OriginalPreparer({ logger: silentLogger, fetch: imageFetch(calls) }).prepare(item, makeDraft(), ctx(profile));
    expect(out).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(out.every((m) => m.thirdParty && m.type === "image" && m.width === 40)).toBe(true);
  });

  it("skips images that fail to download, without throwing", async () => {
    const logger = spyLogger();
    const bad = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const item = makeItem({ media: [{ type: "image", url: "https://cdn.example.com/x.png" }, { type: "image", localPath: photo }] });
    const out = await new OriginalPreparer({ logger, fetch: bad }).prepare(item, makeDraft(), ctx(makeProfile(), logger));
    expect(out.map((m) => m.localPath)).toEqual([photo]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("downloads the video (media url first, then sourceUrl) with maxVideoSec and returns only the video", async () => {
    const dl = fakeDownloader();
    const spy = vi.spyOn(dl, "download");
    const profile = makeProfile({ media: { strategy: "original", maxVideoSec: 90 } });
    const item = makeItem({ sourceUrl: "https://x.com/a/status/1", media: [{ type: "video", url: "https://video.example.com/v.m3u8" }, { type: "image", localPath: photo }] });
    const out = await new OriginalPreparer({ logger: silentLogger, downloader: dl }).prepare(item, makeDraft(), ctx(profile));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "video", thirdParty: true, durationSec: 7 });
    expect(spy.mock.calls[0]![2]).toEqual({ maxDurationSec: 90 });
    expect(dl.calls[0]).toBe("https://video.example.com/v.m3u8");
  });

  it("falls back to sourceUrl when the media url fails, then to the images when everything fails", async () => {
    const urls: string[] = [];
    const dl = fakeDownloader({
      download: async (url, outDir) => {
        urls.push(url);
        if (url.includes("video.example")) throw new DownloaderError("nope", "NOT_FOUND");
        const { mkdir } = await import("node:fs/promises");
        await mkdir(outDir, { recursive: true });
        const f = path.join(outDir, "ok.mp4");
        await writeFile(f, "x");
        return [{ type: "video", localPath: f }];
      },
    });
    const item = makeItem({ sourceUrl: "https://x.com/a/status/1", media: [{ type: "video", url: "https://video.example.com/v.m3u8" }] });
    const out = await new OriginalPreparer({ logger: silentLogger, downloader: dl }).prepare(item, makeDraft(), ctx());
    expect(urls).toEqual(["https://video.example.com/v.m3u8", "https://x.com/a/status/1"]);
    expect(out[0]!.type).toBe("video");

    const failing = fakeDownloader({ download: async () => { throw new DownloaderError("x", "DOWNLOAD_FAILED"); } });
    const withImage = makeItem({ sourceUrl: "https://x.com/a/status/1", media: [{ type: "video", url: "https://video.example.com/v.m3u8" }, { type: "image", localPath: photo }] });
    const out2 = await new OriginalPreparer({ logger: silentLogger, downloader: failing }).prepare(withImage, makeDraft(), ctx());
    expect(out2.map((m) => m.type)).toEqual(["image"]);
    const onlyVideo = makeItem({ media: [{ type: "video", url: "https://video.example.com/v.m3u8" }] });
    expect(await new OriginalPreparer({ logger: silentLogger, downloader: failing }).prepare(onlyVideo, makeDraft(), ctx())).toEqual([]);
  });

  it("does not download video when downloadVideo is false, the downloader is missing or unavailable", async () => {
    const item = makeItem({ sourceUrl: "https://x.com/a/status/1", media: [{ type: "video", url: "https://video.example.com/v.m3u8" }, { type: "image", localPath: photo }] });
    const dl = fakeDownloader();
    const off = makeProfile({ media: { strategy: "original", downloadVideo: false } });
    expect((await new OriginalPreparer({ logger: silentLogger, downloader: dl }).prepare(item, makeDraft(), ctx(off))).map((m) => m.type)).toEqual(["image"]);
    expect(dl.calls).toEqual([]);
    expect((await new OriginalPreparer({ logger: silentLogger }).prepare(item, makeDraft(), ctx())).map((m) => m.type)).toEqual(["image"]);
    const unavailable = fakeDownloader({ isAvailable: async () => false });
    expect((await new OriginalPreparer({ logger: silentLogger, downloader: unavailable }).prepare(item, makeDraft(), ctx())).map((m) => m.type)).toEqual(["image"]);
    expect(unavailable.calls).toEqual([]);
  });

  it("reuses a video that is already local", async () => {
    const f = path.join(dir, "already.mp4");
    await writeFile(f, "x");
    const dl = fakeDownloader();
    const out = await new OriginalPreparer({ logger: silentLogger, downloader: dl }).prepare(makeItem({ media: [{ type: "video", localPath: f }] }), makeDraft(), ctx());
    expect(out[0]!.localPath).toBe(f);
    expect(dl.calls).toEqual([]);
  });
});

describe("render preparer", () => {
  const ok = (over: Partial<RenderInput> = {}) => async (input: RenderInput) => {
    seen.push({ ...input, ...over });
    return [{ type: "image" as const, localPath: path.join(dir, "fake.png"), width: 1080, height: 1350 }];
  };
  const seen: RenderInput[] = [];

  it("renders a real card (PNG 1080x1350, thirdParty false) from remote images", async () => {
    const p = new RenderPreparer({ logger: silentLogger, fetch: imageFetch() });
    const item = makeItem({ media: [{ type: "image", url: "https://cdn.example.com/1.png" }, { type: "image", localPath: photo }] });
    const out = await p.prepare(item, makeDraft(), ctx());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "image", width: 1080, height: 1350, thirdParty: false });
    const meta = await sharp(out[0]!.localPath).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([1080, 1350, "png"]);
  });

  it("maps draft fields and brand into the render input; primaryMediaIndex goes first; credit hide drops the credit", async () => {
    seen.length = 0;
    const p = new RenderPreparer({ logger: silentLogger, renderer: ok(), ffmpegAvailable: async () => false });
    const item = makeItem({ id: "abc", media: [{ type: "image", localPath: photo }, { type: "image", localPath: photo2 }] });
    const draft = makeDraft({ headline: "H", sourceCredit: "Fonte X", extra: { categoryTag: "Tag", mediaPlan: { primaryMediaIndex: 1 } } });
    await p.prepare(item, draft, ctx());
    expect(seen[0]).toMatchObject({ headline: "H", categoryTag: "Tag", sourceCredit: "Fonte X", template: "card", id: "abc", tiktok: false });
    expect(seen[0]!.images).toEqual([photo2, photo]);
    expect(seen[0]!.brand).toMatchObject({ name: "Perfil Teste", handle: "@teste", colors: { accent: "#E5173F" } });

    seen.length = 0;
    const hide = makeProfile({ editorial: { credit: "hide" }, brand: undefined });
    await p.prepare(item, draft, ctx(hide));
    expect(seen[0]!.sourceCredit).toBe("");
    expect(seen[0]!.brand.name).toBe("Perfil Teste"); // profile.name fallback
  });

  it("template auto: card without ffmpeg, video_split with a video + ffmpeg (+ tiktok variant)", async () => {
    seen.length = 0;
    const f = path.join(dir, "local.mp4");
    await writeFile(f, "x");
    const item = makeItem({ media: [{ type: "video", localPath: f }] });
    const tiktok = makeProfile({ destinations: [{ platform: "instagram", publisher: "manual" }, { platform: "tiktok", publisher: "manual" }] });
    await new RenderPreparer({ logger: silentLogger, renderer: ok(), ffmpegAvailable: async () => false }).prepare(item, makeDraft(), ctx(tiktok));
    expect(seen[0]!.template).toBe("card");
    await new RenderPreparer({ logger: silentLogger, renderer: ok(), ffmpegAvailable: async () => true }).prepare(item, makeDraft(), ctx(tiktok));
    expect(seen[1]).toMatchObject({ template: "video_split", video: f, tiktok: true });
  });

  it("returns platform variants from the renderer as PreparedMedia", async () => {
    const renderer = async () => [
      { type: "video" as const, localPath: "/a.mp4", width: 1080, height: 1350, durationSec: 3 },
      { type: "video" as const, localPath: "/b.mp4", platform: "tiktok", width: 1080, height: 1920, durationSec: 3 },
    ];
    const out = await new RenderPreparer({ logger: silentLogger, renderer, ffmpegAvailable: async () => true }).prepare(makeItem(), makeDraft(), ctx());
    expect(out.map((m) => [m.platform, m.height, m.thirdParty])).toEqual([[undefined, 1350, false], ["tiktok", 1920, false]]);
  });

  it("falls back to the original media and warns when rendering throws", async () => {
    const logger = spyLogger();
    const renderer = async () => { throw new Error("satori exploded"); };
    const item = makeItem({ media: [{ type: "image", localPath: photo }] });
    const out = await new RenderPreparer({ logger, renderer }).prepare(item, makeDraft(), ctx(makeProfile(), logger));
    expect(out).toEqual([{ type: "image", localPath: photo, width: 1200, height: 800, thirdParty: true }]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]![0])).toContain("satori exploded");
  });

  it("fallback reuses images already downloaded by the render attempt (no second download)", async () => {
    const calls: string[] = [];
    const renderer = async () => { throw new Error("boom"); };
    const item = makeItem({ media: [{ type: "image", url: "https://cdn.example.com/1.png" }] });
    const out = await new RenderPreparer({ logger: silentLogger, fetch: imageFetch(calls), renderer }).prepare(item, makeDraft(), ctx());
    expect(calls).toHaveLength(1);
    expect(out).toHaveLength(1);
    expect(out[0]!.thirdParty).toBe(true);
  });

  it("renders a text-only card when the item has no media", async () => {
    const out = await new RenderPreparer({ logger: silentLogger }).prepare(makeItem(), makeDraft(), ctx());
    expect(out[0]).toMatchObject({ type: "image", thirdParty: false });
  });

  it.skipIf(!HAS_FFMPEG)("real video_split from a local video: 1080x1350 mp4", async () => {
    const out = await new RenderPreparer({ logger: silentLogger }).prepare(makeItem({ media: [{ type: "video", localPath: video }] }), makeDraft(), ctx());
    expect(out[0]).toMatchObject({ type: "video", width: 1080, height: 1350, thirdParty: false });
    expect(out[0]!.localPath.endsWith(".mp4")).toBe(true);
  }, 90_000);
});
