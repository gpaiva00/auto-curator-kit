import { silentLogger } from "@auto-curator/contracts";
import { describe, expect, it } from "vitest";
import { BrowserError } from "../src/browser/cdp.js";
import { createSource } from "../src/registry.js";
import { contentLength, largeImageUrl, parseArticles, xBlockReason, xPrefilter, type RawArticle, type XSnapshot } from "../src/x-feed.js";
import { parseCount } from "../src/util.js";
import { fakeReader, makeCtx, noSleep } from "./helpers.js";

const long = (s: string) => `${s} ${"palavra ".repeat(20)}`.trim();
const art = (over: Partial<RawArticle>): RawArticle => ({ href: "/gabriel/status/111", userName: "Gabriel\n@gabriel", text: long("texto do post"), time: "2026-11-13T10:00:00.000Z", context: "", likes: "1,2 mil", replyingTo: false, promoted: false, images: [], video: false, ...over });
const snap = (articles: RawArticle[], over: Partial<XSnapshot> = {}): XSnapshot => ({ finalUrl: "https://x.com/home", bodyTextStart: "", articles, ...over });

describe("parseCount", () => {
  it("handles pt-BR and en formats", () => {
    expect(parseCount("1,2 mil")).toBe(1200);
    expect(parseCount("3.4K")).toBe(3400);
    expect(parseCount("1.234")).toBe(1234);
    expect(parseCount("2 mi")).toBe(2_000_000);
    expect(parseCount("")).toBe(0);
  });
});

describe("parseArticles", () => {
  it("extracts id, author, date, likes and drops cards without a status link and duplicates", () => {
    const out = parseArticles({ articles: [art({}), art({ href: "/x/lists/1" }), art({})] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "111", author: "gabriel", url: "https://x.com/gabriel/status/111", likes: 1200, postedAt: "2026-11-13T10:00:00.000Z", isRepost: false, isPinned: false });
  });
  it("detects reposts, pinned posts and replies", () => {
    const [a, b, c] = parseArticles({
      articles: [art({ href: "/other/status/1", context: "Gabriel reposted" }), art({ href: "/gabriel/status/2", context: "Fixado" }), art({ href: "/gabriel/status/3", text: "@amigo concordo totalmente" })],
    });
    expect([a!.isRepost, b!.isPinned, c!.isReply]).toEqual([true, true, true]);
  });
  it("only keeps twimg media urls, upgraded to large", () => {
    const [p] = parseArticles({ articles: [art({ images: ["https://pbs.twimg.com/media/ABC?format=jpg&name=small", "https://evil.example/x.jpg", "http://pbs.twimg.com/media/ABC"] })] });
    expect(p!.images).toEqual(["https://pbs.twimg.com/media/ABC?format=jpg&name=large"]);
    expect(largeImageUrl("https://pbs.twimg.com/profile_images/1.jpg")).toBeUndefined();
  });
});

describe("xBlockReason / xPrefilter", () => {
  it("login wall and throttling", () => {
    expect(xBlockReason(snap([], { finalUrl: "https://x.com/i/flow/login" }))).toBe("login");
    expect(xBlockReason(snap([], { bodyTextStart: "Something went wrong. Try again" }))).toBe("throttled");
    expect(xBlockReason(snap([art({})], { bodyTextStart: "Something went wrong" }))).toBeUndefined();
  });

  const f = { includeReplies: false, minChars: 120, minLikes: 0, ownHandle: "@Gabriel" };
  const post = (over: Partial<RawArticle>) => parseArticles({ articles: [art({ href: "/fulano/status/5", ...over })] })[0]!;
  it("skips ads, own posts, replies, short posts (links do not count) and few likes", () => {
    expect(xPrefilter(post({ promoted: true }), f)).toBe("anúncio");
    expect(xPrefilter(post({ href: "/GABRIEL/status/5" }), f)).toBe("post próprio");
    expect(xPrefilter(post({ replyingTo: true }), f)).toBe("resposta");
    expect(xPrefilter(post({ text: "curto" }), f)).toMatch(/curto/);
    expect(xPrefilter(post({ text: `curto https://t.co/${"a".repeat(200)}` }), f)).toMatch(/curto/);
    expect(xPrefilter(post({}), { ...f, minLikes: 5000 })).toMatch(/poucas curtidas/);
    expect(xPrefilter(post({}), f)).toBeUndefined();
    expect(xPrefilter(post({ replyingTo: true }), { ...f, includeReplies: true })).toBeUndefined();
    expect(contentLength("a  b\nhttps://x.com/abc")).toBe(3);
  });
});

describe("x-feed source", () => {
  const deps = (reader: ReturnType<typeof fakeReader>) => ({ env: {}, logger: silentLogger, pageReader: reader, sleep: noSleep });
  const cfg = (o: Record<string, unknown> = {}) => ({ type: "x-feed", feed: "following", limits: { minDelaySeconds: 0 }, ...o }) as never;

  it("reads the feed tab, filters, sorts by likes and caps", async () => {
    const reader = fakeReader(() =>
      snap([
        art({ href: "/a/status/1", likes: "10" }),
        art({ href: "/b/status/2", likes: "2 mil", images: ["https://pbs.twimg.com/media/IMG?name=small"], video: true }),
        art({ href: "/c/status/3", promoted: true }),
        art({ href: "/gabriel/status/4" }),
        art({ href: "/d/status/5", text: "curto" }),
        art({ href: "/e/status/6", likes: "500" }),
      ]),
    );
    const src = createSource(cfg({ ownHandle: "gabriel", maxPerScan: 2 }), deps(reader));
    const items = await src.fetch(makeCtx());
    expect(items.map((i) => i.dedupeKey)).toEqual(["x:2", "x:6"]);
    expect(items[0]).toMatchObject({
      origin: "feed",
      source: "x-feed",
      sourceUrl: "https://x.com/b/status/2",
      author: "b",
      postedAt: "2026-11-13T10:00:00.000Z",
      engagement: { likes: 2000 },
      media: [{ type: "image", url: "https://pbs.twimg.com/media/IMG?name=large" }, { type: "video" }],
    });
    expect(reader.requests).toHaveLength(1);
    expect(reader.requests[0]!.url).toBe("https://x.com/home");
    expect(reader.requests[0]!.clickTab!.test("Seguindo")).toBe(true);
  });

  it("for_you picks the other tab", async () => {
    const reader = fakeReader(() => snap([art({})]));
    await createSource(cfg({ feed: "for_you" }), deps(reader)).fetch(makeCtx());
    expect(reader.requests[0]!.clickTab!.test("Para você")).toBe(true);
  });

  it("login wall -> AUTH_REQUIRED; throttling -> RATE_LIMITED and the cooldown persists in ctx.state", async () => {
    const ctx = makeCtx();
    const login = fakeReader(() => snap([], { finalUrl: "https://x.com/i/flow/login" }));
    await expect(createSource(cfg(), deps(login)).fetch(ctx)).rejects.toMatchObject({ kind: "AUTH_REQUIRED" });

    const throttled = fakeReader(() => snap([], { bodyTextStart: "Something went wrong" }));
    await expect(createSource(cfg(), deps(throttled)).fetch(ctx)).rejects.toMatchObject({ kind: "RATE_LIMITED" });
    // a brand-new source instance (new scan) still sees the cooldown, without reading again
    const ok = fakeReader(() => snap([art({})]));
    await expect(createSource(cfg(), deps(ok)).fetch(ctx)).rejects.toThrow(/Pausa de segurança/);
    expect(ok.requests).toHaveLength(0);
  });

  it("browser closed -> NOT_AVAILABLE with a pt-BR hint", async () => {
    const err = await createSource(cfg(), deps(fakeReader(() => snap([]), false))).fetch(makeCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(BrowserError);
    expect(err.kind).toBe("NOT_AVAILABLE");
    expect(err.message).toMatch(/chrome-reader\.sh/);
  });

  it("fromInput reads a status URL (joining the author's own thread) and ignores other URLs", async () => {
    const reader = fakeReader(() => snap([art({ text: "parte 1" }), art({ href: "/gabriel/status/112", text: "parte 2", images: ["https://pbs.twimg.com/media/Z"] }), art({ href: "/fan/status/113", text: "comentário" })]));
    const src = createSource(cfg(), deps(reader));
    const item = await src.fromInput!("https://twitter.com/gabriel/status/111?s=20", makeCtx());
    expect(item).toMatchObject({ dedupeKey: "x:111", origin: "manual", author: "gabriel", text: "parte 1\n\nparte 2" });
    expect(item!.media).toEqual([{ type: "image", url: "https://pbs.twimg.com/media/Z?name=large" }]);
    expect(reader.requests[0]!.url).toBe("https://x.com/gabriel/status/111");
    expect(await src.fromInput!("https://example.com/a/status/1", makeCtx())).toBeUndefined();
    expect(await src.fromInput!("https://x.com/gabriel", makeCtx())).toBeUndefined();
    await expect(src.fromInput!("https://x.com/gabriel/status/999", makeCtx())).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
});
