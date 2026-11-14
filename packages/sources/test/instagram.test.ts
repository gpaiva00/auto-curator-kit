import { silentLogger } from "@auto-curator/contracts";
import { describe, expect, it } from "vitest";
import { createSource } from "../src/registry.js";
import { extractProfileLinks, isLoginWall, parsePost, parsePostedAt, snapshotFromHtml, type PageSnapshot, type ProfileSnapshot } from "../src/instagram-profile.js";
import { parseInstagramPostUrl } from "../src/urls.js";
import { fakeReader, fixture, makeCtx, NOW, noSleep } from "./helpers.js";

describe("parsePostedAt", () => {
  it("handles pt-BR and en dates, noon Brasilia", () => {
    expect(parsePostedAt("7 de novembro de 2026")).toBe("2026-11-07T15:00:00.000Z");
    expect(parsePostedAt("November 7, 2026")).toBe("2026-11-07T15:00:00.000Z");
    expect(parsePostedAt("7 de março de 2025")).toBe("2025-03-07T15:00:00.000Z");
    expect(parsePostedAt("sem data")).toBeUndefined();
  });
  it("without a year, never lands in the future", () => {
    expect(parsePostedAt("20 de dezembro", new Date("2026-11-14T00:00:00Z"))).toBe("2025-12-20T15:00:00.000Z");
  });
});

describe("parsePost", () => {
  it("reads the pt-BR og:description of a photo (fixture HTML)", () => {
    const snap = snapshotFromHtml(fixture("instagram-post.html"), "https://www.instagram.com/p/ABCDE12345/");
    expect(parsePost(snap, NOW)).toMatchObject({
      handle: "xuxanave",
      displayName: "Xuxa Nave",
      caption: "Eclipse hoje à noite! Veja como assistir.",
      postedAt: "2026-11-07T15:00:00.000Z",
      likes: 1234,
      comments: 56,
      hasVideo: false,
      imageUrl: "https://scontent.cdninstagram.com/v/t51/abc.jpg?stp=c0.0.640.640a",
    });
  });

  it("reads the en description of a reel and flags the video (cover kept as image url)", () => {
    const snap = snapshotFromHtml(fixture("instagram-reel.html"), "https://www.instagram.com/reel/XYZ12345/");
    expect(parsePost(snap, NOW)).toMatchObject({ handle: "canalciencia", caption: "New video about Mars", likes: 2500, comments: 10, hasVideo: true, displayName: "Canal Ciência" });
  });

  it("prefers the real (uncropped) media image for photos and falls back to caption/header handle", () => {
    const snap: PageSnapshot = { finalUrl: "u", title: "Instagram", bodyTextStart: "", mediaImage: "https://x.fbcdn.net/full.jpg", ogImage: "https://x.fbcdn.net/crop.jpg", captionText: "Legenda visível", headerHandle: "fulano" };
    expect(parsePost(snap, NOW)).toMatchObject({ handle: "fulano", caption: "Legenda visível", imageUrl: "https://x.fbcdn.net/full.jpg" });
  });

  it("detects login walls", () => {
    expect(isLoginWall({ finalUrl: "https://www.instagram.com/accounts/login/?next=/p/x", bodyTextStart: "" })).toBe(true);
    expect(isLoginWall({ finalUrl: "https://www.instagram.com/p/x/", bodyTextStart: "Faça login para continuar" })).toBe(true);
    expect(isLoginWall({ finalUrl: "https://www.instagram.com/p/x/", bodyTextStart: "Entrar", ogDescription: "1 curtida - a em 1 de maio de 2026: \"x\"" })).toBe(false);
  });
});

describe("links", () => {
  it("extractProfileLinks keeps the profile's own posts/reels in order, deduped, dropping other accounts", () => {
    const hrefs = ["/outro/p/ZZZZZ99999/", "/xuxanave/p/AAAAA11111/", "/xuxanave/reel/BBBBB22222/", "/p/CCCCC33333/", "/xuxanave/p/AAAAA11111/?x=1", "https://www.instagram.com/xuxanave/p/DDDDD44444/", "/explore/", "/xuxanave/"];
    expect(extractProfileLinks("@XuxaNave", hrefs, 3)).toEqual(["https://www.instagram.com/p/AAAAA11111/", "https://www.instagram.com/reel/BBBBB22222/", "https://www.instagram.com/p/CCCCC33333/"]);
  });

  it("parseInstagramPostUrl accepts posts/reels/tv and refuses profiles, stories and other hosts", () => {
    expect(parseInstagramPostUrl("https://www.instagram.com/xuxanave/p/ABCDE12345/?igsh=1")).toMatchObject({ kind: "post", code: "ABCDE12345", handle: "xuxanave", url: "https://www.instagram.com/p/ABCDE12345/" });
    expect(parseInstagramPostUrl("https://instagram.com/reels/XYZ12345/")).toMatchObject({ kind: "reel", url: "https://www.instagram.com/reel/XYZ12345/" });
    for (const u of ["https://www.instagram.com/xuxanave/", "https://www.instagram.com/stories/x/1234567/", "https://evil.com/p/ABCDE12345/", "https://user:pw@instagram.com/p/ABCDE12345/"]) {
      expect(parseInstagramPostUrl(u)).toBeUndefined();
    }
  });
});

describe("instagram-profile source", () => {
  const profile = (links: string[]): ProfileSnapshot => ({ finalUrl: "https://www.instagram.com/xuxanave/", hrefs: links, bodyTextStart: "" });
  const posts: Record<string, string> = {
    AAAAA11111: fixture("instagram-post.html"),
    BBBBB22222: fixture("instagram-reel.html"),
    CCCCC33333: fixture("instagram-post.html"),
  };
  const reader = (over: { profile?: ProfileSnapshot; login?: boolean } = {}) =>
    fakeReader((req) => {
      const code = /\/(?:p|reel)\/([A-Za-z0-9_-]+)\//.exec(req.url)?.[1];
      if (!code) return over.profile ?? profile(["/xuxanave/p/AAAAA11111/", "/xuxanave/reel/BBBBB22222/", "/xuxanave/p/CCCCC33333/"]);
      if (over.login) return { ...snapshotFromHtml("", req.url), finalUrl: "https://www.instagram.com/accounts/login/", bodyTextStart: "Entrar" };
      return snapshotFromHtml(posts[code] ?? "", req.url);
    });
  const cfg = (o: Record<string, unknown> = {}) => ({ type: "instagram-profile", handles: ["@xuxanave"], limits: { minDelaySeconds: 0 }, role: "subject", ...o }) as never;
  const mk = (r: ReturnType<typeof reader>, o: Record<string, unknown> = {}) => createSource(cfg(o), { env: {}, logger: silentLogger, pageReader: r, sleep: noSleep });

  it("lists the newest posts, reads each and maps them to RawItems", async () => {
    const r = reader();
    const items = await mk(r, { postsPerHandle: 2 }).fetch(makeCtx());
    expect(r.requests.map((q) => q.url)).toEqual(["https://www.instagram.com/xuxanave/", "https://www.instagram.com/p/AAAAA11111/", "https://www.instagram.com/reel/BBBBB22222/"]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      dedupeKey: "ig:AAAAA11111",
      origin: "profile",
      source: "instagram-profile",
      sourceUrl: "https://www.instagram.com/p/AAAAA11111/",
      author: "xuxanave",
      text: "Eclipse hoje à noite! Veja como assistir.",
      postedAt: "2026-11-07T15:00:00.000Z",
      engagement: { likes: 1234, comments: 56 },
      media: [{ type: "image", url: "https://scontent.cdninstagram.com/v/t51/abc.jpg?stp=c0.0.640.640a" }],
      extra: { kind: "post", role: "subject", hasVideo: false },
    });
    expect(items[1]).toMatchObject({ dedupeKey: "ig:BBBBB22222", media: [{ type: "video" }], extra: { kind: "reel", hasVideo: true, coverUrl: "https://scontent.cdninstagram.com/v/t51/cover.jpg" } });
  });

  it("remembers what it read (and what first contact skipped): the next scan reads only new posts", async () => {
    const ctx = makeCtx();
    await mk(reader(), { postsPerHandle: 1 }).fetch(ctx);
    const r2 = reader({ profile: profile(["/xuxanave/p/NEWPOST999/", "/xuxanave/p/AAAAA11111/", "/xuxanave/reel/BBBBB22222/", "/xuxanave/p/CCCCC33333/"]) });
    posts.NEWPOST999 = fixture("instagram-post.html");
    const items = await mk(r2, { postsPerHandle: 3 }).fetch(ctx);
    expect(items.map((i) => i.dedupeKey)).toEqual(["ig:NEWPOST999"]);
    expect(r2.requests).toHaveLength(2);
  });

  it("login wall stops the run with AUTH_REQUIRED when nothing was read", async () => {
    await expect(mk(reader({ login: true })).fetch(makeCtx())).rejects.toMatchObject({ kind: "AUTH_REQUIRED" });
  });

  it("a challenge page on a profile trips the limiter (RATE_LIMITED, then cooldown)", async () => {
    const ctx = makeCtx();
    const r = reader({ profile: { finalUrl: "https://www.instagram.com/xuxanave/", hrefs: [], bodyTextStart: "Tente novamente mais tarde" } });
    await expect(mk(r).fetch(ctx)).rejects.toMatchObject({ kind: "RATE_LIMITED" });
    await expect(mk(reader()).fetch(ctx)).rejects.toThrow(/Pausa de segurança/);
  });

  it("an empty profile page (no throttle text) just yields nothing", async () => {
    expect(await mk(reader({ profile: profile([]) })).fetch(makeCtx())).toEqual([]);
  });

  it("fromInput reads a post/reel URL as origin manual and ignores profiles", async () => {
    const r = reader();
    const src = mk(r);
    const item = await src.fromInput!("https://www.instagram.com/reel/BBBBB22222/?igsh=abc", makeCtx());
    expect(item).toMatchObject({ dedupeKey: "ig:BBBBB22222", origin: "manual", author: "canalciencia", media: [{ type: "video" }] });
    expect(await src.fromInput!("https://www.instagram.com/xuxanave/", makeCtx())).toBeUndefined();
    expect(await src.fromInput!("https://example.com/p/ABCDE12345/", makeCtx())).toBeUndefined();
  });
});
