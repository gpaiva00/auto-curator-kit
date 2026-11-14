import { KitError, silentLogger, type Source } from "@auto-curator/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_TYPES, createSource, createSources, listSourceTypes, registerSource, unregisterSource } from "../src/index.js";

const deps = { env: {}, logger: silentLogger };
const err = (fn: () => unknown): KitError => {
  try {
    fn();
  } catch (e) {
    return e as KitError;
  }
  throw new Error("did not throw");
};

describe("registry", () => {
  afterEach(() => unregisterSource("meu-plugin"));

  it("creates every built-in type with minimal valid options", () => {
    const minimal: Record<string, object> = {
      rss: { url: "https://a.example.com/feed" },
      "google-news": { query: "astronomia" },
      "google-trends": {},
      manual: {},
      "x-feed": { feed: "following" },
      "instagram-profile": { handles: ["nasa"] },
    };
    for (const t of SOURCE_TYPES) {
      const s = createSource({ type: t.type, enabled: true, ...minimal[t.type] }, deps);
      expect(s.type).toBe(t.type);
      expect(s.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(10);
    }
    expect(SOURCE_TYPES.map((t) => t.type)).toEqual(["rss", "google-news", "google-trends", "manual", "x-feed", "instagram-profile"]);
  });

  it("unknown type: pt-BR message listing the available ones", () => {
    const e = err(() => createSource({ type: "tiktok", enabled: true }, deps));
    expect(e).toBeInstanceOf(KitError);
    expect(e.code).toBe("SOURCE_UNKNOWN_TYPE");
    expect(e.message).toContain('Tipo de fonte desconhecido: "tiktok"');
    expect(e.message).toContain("rss, google-news");
    expect(err(() => createSource({ type: "toString", enabled: true }, deps)).code).toBe("SOURCE_UNKNOWN_TYPE");
  });

  it("bad options: KitError naming the source, the field and the problem", () => {
    let e = err(() => createSource({ type: "rss", enabled: true }, deps));
    expect(e.code).toBe("SOURCE_CONFIG");
    expect(e.message).toBe('Configuração inválida na fonte "rss": "url": campo obrigatório.');
    e = err(() => createSource({ type: "rss", name: "NASA", url: "não é url", enabled: true }, deps));
    expect(e.message).toBe('Configuração inválida na fonte "rss" (NASA): "url": URL inválida.');
    e = err(() => createSource({ type: "x-feed", feed: "trending", enabled: true }, deps));
    expect(e.message).toMatch(/"feed": valor inválido; use um de: following, for_you/);
    e = err(() => createSource({ type: "instagram-profile", handles: [], enabled: true }, deps));
    expect(e.message).toMatch(/"handles": precisa de pelo menos 1/);
    e = err(() => createSource({ type: "google-news", query: "", enabled: true }, deps));
    expect(e.message).toMatch(/"query": não pode ser vazio/);
    e = err(() => createSource({ type: "rss", url: "https://a.example.com/f", maxItems: "10", enabled: true } as never, deps));
    expect(e.message).toMatch(/"maxItems": esperado número, recebido texto/);
  });

  it("typos in option names are reported instead of silently ignored", () => {
    const e = err(() => createSource({ type: "rss", url: "https://a.example.com/f", maxitems: 3, enabled: true } as never, deps));
    expect(e.message).toMatch(/opção desconhecida: maxitems/);
  });

  it("registerSource adds plugins (listed with description), refuses duplicates unless override", () => {
    const plugin: Source = { type: "meu-plugin", name: "p", fetch: async () => [] };
    registerSource("meu-plugin", () => plugin, { description: "Meu plugin." });
    expect(createSource({ type: "meu-plugin", enabled: true }, deps)).toBe(plugin);
    expect(listSourceTypes().at(-1)).toEqual({ type: "meu-plugin", description: "Meu plugin." });
    expect(err(() => registerSource("meu-plugin", () => plugin)).message).toMatch(/Já existe/);
    expect(err(() => registerSource("rss", () => plugin)).code).toBe("SOURCE_REGISTER");
    expect(() => registerSource("meu-plugin", () => plugin, { override: true })).not.toThrow();
    expect(err(() => registerSource("Meu Plugin", () => plugin)).message).toMatch(/inválido/);
  });

  it("createSources skips disabled entries", () => {
    const list = createSources([{ type: "manual", enabled: true }, { type: "manual", name: "off", enabled: false }], deps);
    expect(list).toHaveLength(1);
  });
});
