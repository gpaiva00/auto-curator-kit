import { KitError, silentLogger, type Source, type SourceConfig } from "@auto-curator/contracts";
import { describe, expect, it } from "vitest";
import { createSource, sourceTable } from "../src/index.js";

const deps = { env: {}, logger: silentLogger };
const fake = (type: string) => (cfg: SourceConfig): Source => ({ type, name: cfg.name ?? type, fetch: async () => [] }) as unknown as Source;

describe("plugins.sources (sourceTable)", () => {
  it("tipo novo do projeto entra na tabela ao lado dos do kit", () => {
    const t = sourceTable({ "minha-fonte": fake("minha-fonte") });
    expect(t.get("minha-fonte")?.origin).toBe("projeto");
    expect(t.has("rss")).toBe(true);
    expect(createSource({ type: "minha-fonte", enabled: true, name: "x" }, deps, t).name).toBe("x");
  });
  it("tipo repetido do kit é erro na carga, sem override", () => {
    const e = (() => {
      try {
        sourceTable({ rss: fake("rss") });
      } catch (err) {
        return err as KitError;
      }
    })();
    expect(e).toBeInstanceOf(KitError);
    expect(e?.code).toBe("SOURCE_REGISTER");
    expect(e?.message).toMatch(/Já existe a fonte "rss" \(kit\)\. Use override: true/);
  });
  it("override: true substitui o tipo do kit", () => {
    const t = sourceTable({ rss: { factory: fake("rss-custom"), override: true } });
    expect(t.get("rss")?.origin).toBe("projeto");
    expect(createSource({ type: "rss", enabled: true, name: "r" }, deps, t).name).toBe("r");
  });
  it("tipo inválido no projeto é erro", () => {
    expect(() => sourceTable({ "Minha Fonte": fake("x") })).toThrow(/Tipo de fonte inválido/);
  });
  it("tipo sem plugin continua desconhecido e lista os disponíveis", () => {
    const t = sourceTable();
    expect(() => createSource({ type: "tiktok", enabled: true }, deps, t)).toThrow(/Tipo de fonte desconhecido: "tiktok"/);
  });
});
