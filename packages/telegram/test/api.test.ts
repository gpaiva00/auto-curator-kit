import { describe, expect, it } from "vitest";
import { TelegramApi, TelegramError, clip } from "../src/index.js";
import { fakeFetch, tmpFile } from "./helpers.js";

describe("TelegramApi", () => {
  it("clips text to 4096 and captions to 1024", async () => {
    const n = fakeFetch();
    const api = new TelegramApi("T", n.f);
    await api.sendMessage("1", "x".repeat(5000));
    expect(n.of("sendMessage")[0]!.body.text).toHaveLength(4096);
    expect(n.of("sendMessage")[0]!.body.parse_mode).toBeUndefined();
    await api.sendPhoto("1", tmpFile("a.png"), "c".repeat(2000));
    expect((n.of("sendPhoto")[0]!.form!.get("caption") as string).length).toBe(1024);
    expect(clip("abc", 10)).toBe("abc");
  });

  it("sendMedia: video with size, photo fallback to document", async () => {
    const n = fakeFetch();
    const api = new TelegramApi("T", n.f);
    await api.sendMedia("1", { type: "video", localPath: tmpFile("v.mp4"), width: 1080, height: 1920 }, "cap");
    const v = n.of("sendVideo")[0]!.form!;
    expect(v.get("width")).toBe("1080");
    expect(v.get("video")).toBeInstanceOf(Blob);

    let first = true;
    const flaky = (async (u: any, i: any) => {
      if (String(u).endsWith("sendPhoto") && first) {
        first = false;
        return new Response(JSON.stringify({ ok: false, description: "too big" }), { status: 400 });
      }
      return n.f(u, i);
    }) as typeof fetch;
    await new TelegramApi("T", flaky).sendMedia("1", { type: "image", localPath: tmpFile("a.png") });
    expect(n.of("sendDocument")).toHaveLength(1);
  });

  it("sendMediaGroup, deleteMessages chunking, errors", async () => {
    const n = fakeFetch();
    const api = new TelegramApi("T", n.f);
    await api.sendMediaGroup("1", [{ type: "image", localPath: tmpFile("a.png") }, { type: "video", localPath: tmpFile("b.mp4") }], "cap");
    const media = JSON.parse(n.of("sendMediaGroup")[0]!.form!.get("media") as string);
    expect(media.map((m: any) => m.type)).toEqual(["photo", "video"]);
    await api.deleteMessages("1", Array.from({ length: 150 }, (_, i) => i));
    expect(n.of("deleteMessages").map((c) => c.body.message_ids.length)).toEqual([100, 50]);
    const bad = new TelegramApi("T", (async () => new Response(JSON.stringify({ ok: false, description: "nope" }), { status: 403 })) as typeof fetch);
    await expect(bad.sendMessage("1", "x")).rejects.toBeInstanceOf(TelegramError);
  });
});
