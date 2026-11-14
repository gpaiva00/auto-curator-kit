import { KitError } from "@auto-curator/contracts";
import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/rss.js";
import { createSource } from "../src/registry.js";
import { silentLogger } from "@auto-curator/contracts";
import { fakeFetch, fixture, makeCtx } from "./helpers.js";

const deps = (f: typeof fetch) => ({ env: {}, logger: silentLogger, fetch: f });

describe("parseFeed", () => {
  it("parses RSS 2.0: decodes entities, strips CDATA html, reads media:content and dates", () => {
    const items = parseFeed(fixture("news.rss.xml"));
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      title: "Influencer Exemplo 1 fecha parceria milionaria com marca de tenis",
      link: "https://portal.example.com/exemplo-1-parceria?utm_source=rss",
      summary: "O criador de conteudo Influencer Exemplo 1 anunciou nesta sexta uma nova parceria.",
      publishedAt: "2026-11-07T16:00:00.000Z",
      media: [{ type: "image", url: "https://img.example.com/ex1.jpg" }],
    });
    expect(items[1]!.media).toEqual([]);
    expect(items[2]!.title).toBe("Influencer Exemplo 2 & amigos viajam para Fernando de Noronha");
  });

  it("parses Atom: alternate link, author, escaped html summary, thumbnails and <img> fallback; drops entries without link", () => {
    const items = parseFeed(fixture("atom.xml"));
    expect(items.map((i) => i.title)).toEqual(["Cometa visível a olho nu & como observar", "Eclipse lunar em março"]);
    expect(items[0]).toMatchObject({
      link: "https://blog.example.org/cometa?utm_source=atom",
      author: "Marina Lopes",
      summary: "O cometa chega ao ponto mais brilhante nesta semana .",
      publishedAt: "2026-11-10T09:30:00.000Z",
      media: [{ type: "image", url: "https://img.example.org/cometa.jpg" }],
    });
    expect(items[1]!.media).toEqual([{ type: "image", url: "https://img.example.org/eclipse.png" }]);
    expect(items[1]!.publishedAt).toBe("2026-11-09T08:00:00.000Z");
  });

  it("reads enclosure video/image", () => {
    const xml = `<rss><channel><item><title>V</title><link>https://a.example.com/v</link>
      <enclosure url="https://cdn.example.com/v.mp4" type="video/mp4" length="1"/>
      <enclosure url="https://cdn.example.com/i.jpg" type="image/jpeg" length="1"/></item></channel></rss>`;
    expect(parseFeed(xml)[0]!.media).toEqual([
      { type: "video", url: "https://cdn.example.com/v.mp4" },
      { type: "image", url: "https://cdn.example.com/i.jpg" },
    ]);
  });
});

describe("rss source", () => {
  const url = "https://portal.example.com/feed.xml";

  it("returns RawItems with canonical dedupeKey, origin feed and og:image looked up on the article page", async () => {
    const f = fakeFetch({
      [url]: { body: fixture("news.rss.xml"), type: "application/rss+xml" },
      "https://portal.example.com/tempo": fixture("article.html"),
      "https://portal.example.com/exemplo-2-noronha": "<html><head></head></html>",
    });
    const src = createSource({ type: "rss", url, name: "Portal", enabled: true }, deps(f));
    const items = await src.fetch(makeCtx());
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      dedupeKey: "rss:https://portal.example.com/exemplo-1-parceria",
      origin: "feed",
      source: "Portal",
      sourceUrl: "https://portal.example.com/exemplo-1-parceria?utm_source=rss",
      title: "Influencer Exemplo 1 fecha parceria milionaria com marca de tenis",
      media: [{ type: "image", url: "https://img.example.com/ex1.jpg" }],
    });
    // no media in the feed -> og:image from the article (relative URL resolved)
    expect(items[1]!.media).toEqual([{ type: "image", url: "https://portal.example.com/img/webb.jpg" }]);
    expect(items[2]!.media).toEqual([]);
    // the article of an item that already has an image is not fetched
    expect(f.calls).not.toContain("https://portal.example.com/exemplo-1-parceria?utm_source=rss");
  });

  it("fetchImage=false never touches article pages; maxItems caps", async () => {
    const f = fakeFetch({ [url]: fixture("news.rss.xml") });
    const src = createSource({ type: "rss", url, fetchImage: false, maxItems: 2 } as never, deps(f));
    const items = await src.fetch(makeCtx());
    expect(items).toHaveLength(2);
    expect(f.calls).toEqual([url]);
    expect(src.name).toBe("portal.example.com");
  });

  it("does not follow article links to private hosts", async () => {
    const xml = `<rss><channel><item><title>x</title><link>http://127.0.0.1/admin</link></item></channel></rss>`;
    const f = fakeFetch({ [url]: xml });
    const items = await createSource({ type: "rss", url } as never, deps(f)).fetch(makeCtx());
    expect(items).toHaveLength(1);
    expect(f.calls).toEqual([url]);
  });

  it("explains HTTP errors and non-feed bodies in pt-BR", async () => {
    const src = (body: string, status = 200) => createSource({ type: "rss", url, name: "X" } as never, deps(fakeFetch({ [url]: { body, status } })));
    await expect(src("", 503).fetch(makeCtx())).rejects.toThrow(/HTTP 503/);
    await expect(src("<html>oi</html>").fetch(makeCtx())).rejects.toThrow(/não parece um feed/);
    await expect(src("").fetch(makeCtx())).rejects.toBeInstanceOf(KitError);
  });
});
