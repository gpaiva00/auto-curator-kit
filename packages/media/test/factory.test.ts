import { describe, expect, it } from "vitest";
import { silentLogger } from "@auto-curator/contracts";
import { NonePreparer, OriginalPreparer, RenderPreparer, YtDlpDownloader, createDownloaderFromEnv, createPreparer } from "../src/index.js";
import { makeProfile } from "./fixtures/make.js";

describe("createPreparer", () => {
  it.each([
    ["none", NonePreparer],
    ["original", OriginalPreparer],
    ["render", RenderPreparer],
  ] as const)("strategy %s", (strategy, cls) => {
    const p = createPreparer(makeProfile({ media: { strategy } }), { logger: silentLogger });
    expect(p).toBeInstanceOf(cls);
    expect(p.strategy).toBe(strategy);
  });
  it("defaults to original", () => {
    expect(createPreparer(makeProfile({ media: {} }), { logger: silentLogger }).strategy).toBe("original");
  });
});

describe("createDownloaderFromEnv", () => {
  it("returns a yt-dlp downloader by default", () => {
    expect(createDownloaderFromEnv({})).toBeInstanceOf(YtDlpDownloader);
  });
  it("DOWNLOADER_DISABLED=1 (or true) disables it", () => {
    expect(createDownloaderFromEnv({ DOWNLOADER_DISABLED: "1" })).toBeUndefined();
    expect(createDownloaderFromEnv({ DOWNLOADER_DISABLED: "true" })).toBeUndefined();
    expect(createDownloaderFromEnv({ DOWNLOADER_DISABLED: "0" })).toBeInstanceOf(YtDlpDownloader);
  });
  it("YTDLP_BIN pointing nowhere makes it unavailable instead of throwing", async () => {
    const d = createDownloaderFromEnv({ YTDLP_BIN: "/nonexistent/yt-dlp" })!;
    expect(await d.isAvailable()).toBe(false);
  });
});
