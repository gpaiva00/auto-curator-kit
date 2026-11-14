import { silentLogger } from "@auto-curator/contracts";
import { describe, expect, it } from "vitest";
import { buildGoogleNewsUrl } from "../src/google-news.js";
import { parseTraffic, parseTrendsRss } from "../src/google-trends.js";
import { createSource } from "../src/registry.js";
import { fakeFetch, fixture, makeCtx } from "./helpers.js";

const deps = (f: typeof fetch) => ({ env: {}, logger: silentLogger, fetch: f });

describe("google-news", () => {
  it("builds the search URL with defaults and encodes the query", () => {
    const u = new URL(buildGoogleNewsUrl({ query: '"James Webb" OR eclipse' }));
    expect(u.origin + u.pathname).toBe("https://news.google.com/rss/search");
    expect(u.searchParams.get("q")).toBe('"James Webb" OR eclipse');
    expect(u.searchParams.get("hl")).toBe("pt-BR");
    expect(u.searchParams.get("gl")).toBe("BR");
    expect(u.searchParams.get("ceid")).toBe("BR:pt-419");
    expect(buildGoogleNewsUrl({ query: "a&b" })).toContain("q=a%26b");
  });

  it("honours hl/gl/ceid overrides", () => {
    const u = new URL(buildGoogleNewsUrl({ query: "space", hl: "en-US", gl: "US", ceid: "US:en" }));
    expect([u.searchParams.get("hl"), u.searchParams.get("gl"), u.searchParams.get("ceid")]).toEqual(["en-US", "US", "US:en"]);
  });

  it("reuses rss parsing: publisher as author, dedupe on the Google link", async () => {
    const feedUrl = buildGoogleNewsUrl({ query: "James Webb" });
    const f = fakeFetch({ [feedUrl]: { body: fixture("google-news.rss.xml"), type: "application/rss+xml" } });
    const src = createSource({ type: "google-news", query: "James Webb" } as never, deps(f));
    expect(src.name).toBe("Google News: James Webb");
    const [item] = await src.fetch(makeCtx());
    expect(item).toMatchObject({
      origin: "feed",
      source: "Google News: James Webb",
      author: "Portal Ciência",
      title: "Webb registra galáxia mais antiga - Portal Ciência",
      dedupeKey: "rss:https://news.google.com/rss/articles/cbmiaaa?oc=5",
    });
    expect(item!.text).toContain("Webb registra galáxia mais antiga");
  });
});

describe("google-trends", () => {
  it("parses traffic strings", () => {
    expect([parseTraffic("200 mil+"), parseTraffic("2 mi+"), parseTraffic("500+"), parseTraffic(undefined)]).toEqual([200_000, 2_000_000, 500, 0]);
  });

  it("parses the trends fixture", () => {
    const trends = parseTrendsRss(fixture("trends-br.rss.xml"));
    expect(trends.length).toBeGreaterThan(0);
    expect(trends[0]).toMatchObject({ name: "Influencer Exemplo 1", approxTraffic: 200_000 });
    expect(trends[0]!.news.map((n) => n.title)).toEqual(["Exemplo 1 anuncia turnê nacional", "Fãs lotam venda de ingressos & derrubam site"]);
  });

  it("makes items with the trend and its related news titles, origin feed, extra.trend", async () => {
    const f = fakeFetch({ "https://trends.google.com/trending/rss?geo=BR": { body: fixture("trends-br.rss.xml"), type: "application/rss+xml" } });
    const src = createSource({ type: "google-trends" } as never, deps(f));
    const items = await src.fetch(makeCtx());
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.extra!.approxTraffic as number).toBeGreaterThanOrEqual(items.at(-1)!.extra!.approxTraffic as number);
    const first = items.find((i) => i.title === "Influencer Exemplo 1")!;
    expect(first).toMatchObject({ origin: "feed", title: "Influencer Exemplo 1", sourceUrl: "https://portal.example.com/exemplo-1-turne" });
    expect(first.dedupeKey).toBe("trend:BR:influencer-exemplo-1:2026-11-07");
    expect(first.text).toBe("Influencer Exemplo 1\n\n- Exemplo 1 anuncia turnê nacional (Exemplo Portal)\n- Fãs lotam venda de ingressos & derrubam site (Noticias Exemplo)");
    expect(first.extra).toMatchObject({ trend: true, geo: "BR", approxTraffic: 200_000 });
  });

  it("uses the configured geo and rejects a bad one", async () => {
    const f = fakeFetch({ "https://trends.google.com/trending/rss?geo=US": fixture("trends-br.rss.xml") });
    const items = await createSource({ type: "google-trends", geo: "US" } as never, deps(f)).fetch(makeCtx());
    expect(items[0]!.extra!.geo).toBe("US");
    expect(() => createSource({ type: "google-trends", geo: "brasil" } as never, deps(f))).toThrow(/geo/);
  });
});
