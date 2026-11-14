import { silentLogger } from "@auto-curator/contracts";
import { describe, expect, it } from "vitest";
import { createSource } from "../src/registry.js";
import { orderForInput } from "../src/manual.js";
import { fakeFetch, fixture, makeCtx } from "./helpers.js";

const make = (routes: Record<string, string | { body: string; status?: number }> = {}) => {
  const f = fakeFetch(routes);
  return { f, src: createSource({ type: "manual", enabled: true }, { env: {}, logger: silentLogger, fetch: f }) };
};

describe("manual source", () => {
  it("fetch returns nothing", async () => {
    expect(await make().src.fetch(makeCtx())).toEqual([]);
  });

  it("reads og:title/description/image/article text from a URL", async () => {
    const url = "https://ciencia.example.com/webb?utm_source=x";
    const { src, f } = make({ [url]: fixture("article.html") });
    const item = await src.fromInput!(url, makeCtx());
    expect(item).toMatchObject({
      origin: "manual",
      source: "manual",
      sourceUrl: url,
      dedupeKey: "manual:url:https://ciencia.example.com/webb",
      title: "Webb registra a galáxia mais antiga já vista",
      author: "Portal Ciência",
      postedAt: "2026-11-12T18:00:00.000Z",
      media: [{ type: "image", url: "https://ciencia.example.com/img/webb.jpg" }],
    });
    expect(item!.text).toBe(
      "Astrônomos confirmaram nesta semana a detecção da galáxia mais distante já observada pelo telescópio.\n\nA análise espectroscópica indica que a luz levou mais de treze bilhões de anos para chegar até nós.",
    );
    expect(f.calls).toEqual([url]);
  });

  it("falls back to og:description when there is no article body", async () => {
    const url = "https://x.example.com/p";
    const { src } = make({ [url]: `<html><head><meta property="og:title" content="T"><meta property="og:description" content="Descrição"></head><body></body></html>` });
    expect((await src.fromInput!(url, makeCtx()))!.text).toBe("Descrição");
  });

  it("a caption pasted after the URL wins over the page text", async () => {
    const url = "https://ciencia.example.com/webb";
    const { src } = make({ [url]: fixture("article.html") });
    const item = await src.fromInput!(`${url} minha legenda\ncom duas linhas`, makeCtx());
    expect(item!.text).toBe("minha legenda\ncom duas linhas");
    expect(item!.title).toBe("Webb registra a galáxia mais antiga já vista");
  });

  it("still returns an item (url as text) when the page cannot be read", async () => {
    const url = "https://down.example.com/a";
    const { src } = make({ [url]: { body: "", status: 500 } });
    const item = await src.fromInput!(url, makeCtx());
    expect(item).toMatchObject({ origin: "manual", text: url, extra: { fetched: false } });
  });

  it("never fetches private addresses", async () => {
    const { src, f } = make();
    const item = await src.fromInput!("http://192.168.0.1/admin", makeCtx());
    expect(item!.extra!.fetched).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("leaves X and Instagram URLs to the specialised sources", async () => {
    const { src, f } = make();
    for (const u of ["https://x.com/a/status/1", "https://twitter.com/a/status/1", "https://www.instagram.com/p/ABCDE12345/", "https://instagram.com/reel/XYZ12345/ legenda"]) {
      expect(await src.fromInput!(u, makeCtx())).toBeUndefined();
    }
    expect(f.calls).toEqual([]);
  });

  it("turns free text into an item with a stable key", async () => {
    const { src } = make();
    const a = await src.fromInput!("  Ideia: falar sobre o eclipse  ", makeCtx());
    const b = await src.fromInput!("ideia:   falar sobre o ECLIPSE", makeCtx());
    expect(a).toMatchObject({ origin: "manual", text: "Ideia: falar sobre o eclipse", media: [] });
    expect(a!.dedupeKey).toBe(b!.dedupeKey);
    expect(await src.fromInput!("   ", makeCtx())).toBeUndefined();
  });
});

describe("orderForInput", () => {
  it("puts manual sources last and keeps the rest in order", () => {
    const list = [{ type: "manual" }, { type: "rss" }, { type: "x-feed" }, { type: "manual" }, { type: "instagram-profile" }];
    expect(orderForInput(list).map((s) => s.type)).toEqual(["rss", "x-feed", "instagram-profile", "manual", "manual"]);
    expect(list[0]!.type).toBe("manual"); // input untouched
  });
});
