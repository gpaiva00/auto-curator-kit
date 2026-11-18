import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Draft, silentLogger, type MediaHost, type Publisher, type RawItem, type Source, type SourceConfig } from "@auto-curator/contracts";
import { ConfigError } from "@auto-curator/engine";
import { bufferIo } from "../src/io.js";
import { run } from "../src/main.js";
import { resolveParts } from "../src/checks.js";
import { buildRuntime } from "../src/wire.js";
import { cleanEnv, REPO_PROFILES, tmpDir } from "./helpers.js";

/** Cópia temporária do perfil de exemplo, com o profile.json alterado por `change`. */
function profileWith(change: (pj: Record<string, unknown>) => void): string {
  const dir = join(tmpDir(), "perfil");
  cpSync(join(REPO_PROFILES, "astronomia"), dir, { recursive: true, filter: (src) => !/(^|\/)\.env$/.test(src) });
  const pj = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as Record<string, unknown>;
  change(pj);
  writeFileSync(join(dir, "profile.json"), JSON.stringify(pj));
  return dir;
}

const fakeSource = (cfg: SourceConfig): Source => ({ type: "minha-fonte", name: cfg.name ?? "minha-fonte", fetch: async () => [] as RawItem[] });
const fakePublisher = (): Publisher & { published: string[] } => {
  const published: string[] = [];
  return { name: "fake", published, publish: async (req) => (published.push(req.text), { externalId: "ext-1", mode: "draft" }) };
};
const fakeHost: MediaHost = { name: "host-falso", supports: () => true, upload: async (p) => `https://cdn.test/${basename(p)}` };
const oneSource = (pj: Record<string, unknown>) => void (pj.sources = [{ type: "minha-fonte", name: "projeto" }]);
const fakeDest = (pj: Record<string, unknown>) => void (pj.destinations = [{ platform: "instagram", publisher: "fake", mode: "draft", dailyCap: 4, only: "any" }]);

describe("plugins: fontes do projeto (seção 3)", () => {
  it("tipo novo do projeto entra no runtime", () => {
    const dir = profileWith((pj) => {
      oneSource(pj);
      fakeDest(pj);
    });
    const rt = buildRuntime(dir, cleanEnv(tmpDir(), { GROQ_API_KEY: "g" }), { logger: silentLogger, plugins: { sources: { "minha-fonte": fakeSource }, publishers: { fake: fakePublisher() } } });
    try {
      expect(rt.sources.map((s) => s.type)).toEqual(["minha-fonte"]);
    } finally {
      rt.close();
    }
  });

  it("tipo repetido do kit é erro na carga, sem override; com override vale o do projeto", () => {
    const dir = profileWith((pj) => {
      pj.sources = [{ type: "rss", url: "https://a.test/f" }];
      fakeDest(pj);
    });
    const env = cleanEnv(tmpDir(), { GROQ_API_KEY: "g" });
    const publishers = { fake: fakePublisher() };
    expect(() => buildRuntime(dir, env, { logger: silentLogger, plugins: { sources: { rss: fakeSource }, publishers } })).toThrow(/Já existe a fonte "rss" \(kit\)/);
    const rt = buildRuntime(dir, env, { logger: silentLogger, plugins: { sources: { rss: { factory: fakeSource, override: true } }, publishers } });
    rt.close();
  });
});

describe("validação na carga (seção 4)", () => {
  it("sources[i].type desconhecido: erro com caminho", () => {
    const dir = profileWith((pj) => void (pj.sources = [{ type: "rss", url: "https://a.test/f" }, { type: "tiktok" }]));
    const err = (() => {
      try {
        buildRuntime(dir, cleanEnv(tmpDir(), { GROQ_API_KEY: "g" }), { logger: silentLogger });
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err?.code).toBe("CONFIG");
    expect(err?.message).toMatch(/sources\[1\]\.type: tipo "tiktok" desconhecido/);
  });

  it("publicador inexistente no destino: erro com caminho e a lista dos disponíveis", () => {
    const dir = profileWith((pj) => void (pj.destinations = [{ platform: "instagram", publisher: "threads-x" }]));
    expect(() => buildRuntime(dir, cleanEnv(tmpDir(), { GROQ_API_KEY: "g" }), { logger: silentLogger, plugins: { publishers: { fake: fakePublisher() } } })).toThrow(
      /destinations\[0\] \(instagram\): publicador "threads-x" não existe\. Disponíveis: fake/,
    );
  });

  it("chave do modelo ausente: erro com o nome da variável, nunca com o valor", () => {
    const dir = profileWith(oneSource);
    const env = cleanEnv(tmpDir(), { TELEGRAM_BOT_TOKEN: "123:SEGREDO-TOKEN" });
    let msg = "";
    try {
      buildRuntime(dir, env, { withTelegram: true, logger: silentLogger });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/variável GROQ_API_KEY \(chave do modelo "triage"\) não está definida/);
    expect(msg).toMatch(/TELEGRAM_ALLOWED_CHAT_IDS/);
    expect(msg).not.toContain("SEGREDO-TOKEN");
  });

  it("destino com mídia sem host, publicador do projeto: aviso, não erro", () => {
    const dir = profileWith((pj) => {
      oneSource(pj);
      fakeDest(pj);
    });
    const parts = resolveParts(buildBundle(dir), cleanEnv(tmpDir(), { GROQ_API_KEY: "g" }), { plugins: { sources: { "minha-fonte": fakeSource }, publishers: { fake: fakePublisher() } } });
    expect(parts.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(parts.issues.find((i) => i.kind === "host" && i.level === "warning")?.text).toMatch(/sem host de mídia/);
  });
});

describe("doctor (seção 4): sai com 1 e mostra o caminho", () => {
  it("fonte com tipo desconhecido derruba o doctor", async () => {
    const dir = profileWith((pj) => void (pj.sources = [{ type: "tiktok" }]));
    const io = bufferIo();
    const code = await run(["doctor", "--offline", "--profile", dir], { env: cleanEnv(tmpDir(), { GROQ_API_KEY: "g" }), io });
    expect(code).toBe(1);
    expect(io.text()).toMatch(/sources\[0\]\.type: tipo "tiktok" desconhecido/);
  });
});

describe("ponta a ponta com publicador e host do projeto", () => {
  it("aprovação publica pelo publicador injetado, com o host de mídia disponível", async () => {
    const dir = profileWith((pj) => {
      oneSource(pj);
      fakeDest(pj);
    });
    const pub = fakePublisher();
    const rt = buildRuntime(dir, cleanEnv(tmpDir(), { GROQ_API_KEY: "g" }), {
      logger: silentLogger,
      plugins: { sources: { "minha-fonte": fakeSource }, publishers: { fake: pub }, mediaHost: fakeHost },
    });
    try {
      expect(rt.publishers.fake).toBe(pub);
      const now = new Date().toISOString();
      const item = rt.store.insertRaw({
        dedupeKey: "e2e:1", origin: "feed", source: "minha-fonte", author: "Fonte", title: "Descoberta de teste", text: "Texto da fonte do projeto, com dados suficientes.",
        sourceUrl: "https://example.com/1", postedAt: now, engagement: {},
      } as RawItem);
      if (!item) throw new Error("item não criado");
      for (const to of ["scored", "curated", "ready", "pending_approval"] as const) rt.store.transition(item.id, to);
      rt.store.setDraft(item.id, Draft.parse({ verdict: "publish", headline: "Título", body: "Corpo do post de teste, com tamanho suficiente.", hashtags: [], sourceCredit: "Fonte: Fonte", confidence: 0.9 }));
      await rt.app.approve(item.id);
      expect(pub.published).toHaveLength(1);
      expect(rt.store.publicationsOf(item.id)[0]?.publisher).toBe("fake");
    } finally {
      rt.close();
    }
  });
});

import { loadProfile, type ProfileBundle } from "@auto-curator/engine";
function buildBundle(dir: string): ProfileBundle {
  return loadProfile(dir, cleanEnv(tmpDir()));
}
