import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { silentLogger, type JsonRequest, type MediaHost, type Publisher, type RawItem, type Source, type SourceConfig } from "@auto-curator/contracts";
import { ConfigError, loadProfile } from "@auto-curator/engine";
import { FakeLlm } from "@auto-curator/engine/testing";
import { approvalText } from "@auto-curator/telegram";
import { fakeDraft } from "../src/commands/dryrun.js";
import { bufferIo } from "../src/io.js";
import { run } from "../src/main.js";
import { resolveParts } from "../src/checks.js";
import { buildRuntime, uiConfig } from "../src/wire.js";
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

const fakeSource = (_cfg: SourceConfig): Source => ({ type: "minha-fonte", name: "minha-fonte", fetch: async () => [] as RawItem[] });
const fakePublisher = (): Publisher & { published: string[] } => {
  const published: string[] = [];
  return { name: "fake", published, publish: async (req) => (published.push(req.text), { externalId: "ext-1", mode: "draft" }) };
};
const fakeHost: MediaHost = { name: "host-falso", supports: () => true, upload: async (p) => `https://cdn.test/${basename(p)}` };
const oneSource = (pj: Record<string, unknown>) => void (pj.sources = [{ type: "minha-fonte", name: "projeto" }]);
const fakeDest = (pj: Record<string, unknown>) => void (pj.destinations = [{ platform: "instagram", publisher: "fake", mode: "draft", dailyCap: 4, only: "any" }]);
const envOk = () => cleanEnv(tmpDir(), { GROQ_API_KEY: "g" });
const buildErr = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("plugins: fontes do projeto (seção 3)", () => {
  it("tipo novo do projeto entra no runtime", () => {
    const dir = profileWith((pj) => {
      oneSource(pj);
      fakeDest(pj);
    });
    const rt = buildRuntime(dir, envOk(), { logger: silentLogger, plugins: { sources: { "minha-fonte": fakeSource }, publishers: { fake: fakePublisher() } } });
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
    const publishers = { fake: fakePublisher() };
    expect(buildErr(() => buildRuntime(dir, envOk(), { logger: silentLogger, plugins: { sources: { rss: fakeSource }, publishers } }))).toMatch(/Já existe a fonte "rss" \(kit\)/);
    const rt = buildRuntime(dir, envOk(), { logger: silentLogger, plugins: { sources: { rss: { factory: fakeSource, override: true } }, publishers } });
    rt.close();
  });
});

describe("validação na carga (seção 4)", () => {
  it("sources[i].type desconhecido: erro com caminho e código CONFIG", () => {
    const dir = profileWith((pj) => {
      pj.sources = [{ type: "rss", url: "https://a.test/f" }, { type: "tiktok" }];
      fakeDest(pj);
    });
    let err: ConfigError | undefined;
    try {
      buildRuntime(dir, envOk(), { logger: silentLogger, plugins: { publishers: { fake: fakePublisher() } } });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(err?.code).toBe("CONFIG");
    expect(err?.message).toMatch(/sources\[1\]\.type: tipo "tiktok" desconhecido/);
  });

  it("publicador inexistente no destino: erro com caminho e a lista dos disponíveis", () => {
    const dir = profileWith((pj) => {
      oneSource(pj);
      pj.destinations = [{ platform: "instagram", publisher: "threads-x" }];
    });
    expect(buildErr(() => buildRuntime(dir, envOk(), { logger: silentLogger, plugins: { sources: { "minha-fonte": fakeSource }, publishers: { fake: fakePublisher() } } }))).toMatch(
      /destinations\[0\] \(instagram\): publicador "threads-x" não existe\. Disponíveis: fake/,
    );
  });

  it('publisher obrigatório: ausente sugere "manual" ou "buffer"', () => {
    const dir = profileWith((pj) => {
      oneSource(pj);
      pj.destinations = [{ platform: "instagram" }];
    });
    expect(buildErr(() => loadProfile(dir, envOk()))).toMatch(/destinations\[0\]\.publisher: publicador obrigatório: use "manual", "buffer"/);
  });

  it('plugin com id "manual" é rejeitado na carga, porque o id é reservado', () => {
    const dir = profileWith((pj) => {
      oneSource(pj);
      fakeDest(pj);
    });
    expect(buildErr(() => buildRuntime(dir, envOk(), { logger: silentLogger, plugins: { sources: { "minha-fonte": fakeSource }, publishers: { manual: fakePublisher(), fake: fakePublisher() } } }))).toMatch(
      /"manual" é reservado pelo kit/,
    );
  });

  it("chave do modelo ausente: erro com o nome da variável, nunca com o valor", () => {
    const dir = profileWith((pj) => {
      oneSource(pj);
      fakeDest(pj);
    });
    const env = cleanEnv(tmpDir(), { TELEGRAM_BOT_TOKEN: "123:SEGREDO-TOKEN" });
    const msg = buildErr(() => buildRuntime(dir, env, { withTelegram: true, logger: silentLogger, plugins: { sources: { "minha-fonte": fakeSource }, publishers: { fake: fakePublisher() } } }));
    expect(msg).toMatch(/papel "triage" sem chave: defina ao menos uma destas variáveis: GROQ_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY/);
    expect(msg).toMatch(/TELEGRAM_ALLOWED_CHAT_IDS/);
    expect(msg).not.toContain("SEGREDO-TOKEN");
  });

  it("destino com mídia sem host, publicador do projeto: aviso, não erro", () => {
    const dir = profileWith((pj) => {
      oneSource(pj);
      fakeDest(pj);
    });
    const parts = resolveParts(loadProfile(dir, envOk()), envOk(), { plugins: { sources: { "minha-fonte": fakeSource }, publishers: { fake: fakePublisher() } } });
    expect(parts.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(parts.issues.find((i) => i.kind === "host" && i.level === "warning")?.text).toMatch(/sem host de mídia/);
    expect(parts.noMediaHost).toEqual(["instagram"]);
  });
});

describe("chaves extras e doctor (seção 4 + decisão do CTO)", () => {
  it("chave extra vira erro com caminho", () => {
    const dir = profileWith((pj) => {
      oneSource(pj);
      pj.destinations = [{ platform: "instagram", publisher: "manual", tipo: "buffer" }];
    });
    expect(buildErr(() => loadProfile(dir, envOk()))).toMatch(/destinations\[0\]\.tipo: chave desconhecida/);
  });

  it("várias chaves extras aparecem juntas numa única execução do doctor", async () => {
    const dir = profileWith((pj) => {
      pj.sources = [{ type: "rss", url: "https://a.test/f", tipe: "x" }];
      pj.destinations = [{ platform: "instagram", publisher: "manual", tipo: "buffer" }];
      pj.foo = 1;
    });
    const io = bufferIo();
    const code = await run(["doctor", "--offline", "--profile", dir], { env: envOk(), io });
    expect(code).toBe(1);
    const out = io.text();
    expect(out).toMatch(/sources\[0\]\.tipe: chave desconhecida/);
    expect(out).toMatch(/destinations\[0\]\.tipo: chave desconhecida/);
    expect(out).toMatch(/foo: chave desconhecida/);
  });
});

describe("ponta a ponta: pipeline real com Store real, Telegram com HTTP falso, publicador e host do projeto", () => {
  it("ingestão, triagem falsa, curadoria falsa, cartão no Telegram, aprovação e publicação pelo publicador do projeto", async () => {
    const dir = profileWith((pj) => {
      oneSource(pj);
      fakeDest(pj);
    });
    const bundle = loadProfile(dir, envOk());
    const now = new Date().toISOString();
    const raw: RawItem = {
      dedupeKey: "e2e:1", origin: "feed", source: "minha-fonte", author: "Agência Teste", title: "Descoberta importante anunciada hoje",
      text: "Pesquisadores anunciaram uma descoberta importante, com dados publicados e fonte verificável.", sourceUrl: "https://example.com/noticia-1",
      postedAt: now, engagement: { likes: 900 }, media: [], extra: {},
    };
    const source: Source = { type: "minha-fonte", name: "projeto", fetch: async () => [raw] };
    const llm = new FakeLlm({
      triage: (req: JsonRequest<unknown>) => {
        const p = JSON.parse(req.user) as { items: { id: string }[] };
        return p.items.map((i) => ({ id: i.id, score: 85, reason: "relevante" }));
      },
      curator: (req: JsonRequest<unknown>) => {
        const p = JSON.parse(req.user) as { item: { title?: string | null; text?: string; author?: string; sourceUrl?: string | null } };
        return fakeDraft(bundle, p.item);
      },
    });
    // HTTP falso do Telegram: grava cada chamada e responde como a API.
    const telegramCalls: string[] = [];
    const telegramFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      telegramCalls.push(`${String(url)} ${typeof init?.body === "string" ? init.body : ""}`);
      return new Response(JSON.stringify({ ok: true, result: { message_id: telegramCalls.length, chat: { id: 7 }, date: 0, text: "" } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const pub = fakePublisher();
    const env = cleanEnv(tmpDir(), { GROQ_API_KEY: "g", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOWED_CHAT_IDS: "7" });
    const rt = buildRuntime(dir, env, {
      withTelegram: true,
      logger: silentLogger,
      llm,
      telegramFetch,
      plugins: { sources: { "minha-fonte": () => source }, publishers: { fake: pub }, mediaHost: fakeHost },
    });
    try {
      await rt.app.ingest();
      await rt.app.runPipeline();
      const [item] = rt.store.list(["pending_approval"]);
      expect(item, "item deveria estar aguardando aprovação").toBeDefined();
      expect(llm.calls.map((c) => c.role)).toEqual(expect.arrayContaining(["triage", "curator"]));
      expect(telegramCalls.join("\n")).toMatch(/sendMessage/);
      expect(telegramCalls.join("\n")).toMatch(/Confiança/);

      await rt.app.approve(item!.id);
      expect(pub.published).toHaveLength(1);
      const pubRow = rt.store.publicationsOf(item!.id)[0];
      expect(pubRow?.publisher).toBe("fake");
      expect(pubRow?.externalId).toBe("ext-1");
    } finally {
      rt.close();
    }
  }, 60000);
});

describe("aviso de aprovação: destino com mídia sem host", () => {
  it("o cartão avisa quando o item tem mídia e a plataforma não tem host", () => {
    const dir = profileWith((pj) => {
      oneSource(pj);
      fakeDest(pj);
    });
    const bundle = loadProfile(dir, envOk());
    const item = {
      id: "i1", profileId: bundle.profile.id, status: "pending_approval", origin: "feed", source: "minha-fonte", author: "A", title: "T",
      text: "texto", sourceUrl: "https://example.com/1", media: [{ type: "image" as const, url: "https://example.com/a.jpg" }], prepared: [], draft: undefined,
    } as unknown as Parameters<typeof approvalText>[0];
    const ui = uiConfig(bundle, ["instagram"]);
    expect(approvalText(item, ui)).toMatch(/Sem host de mídia: .*sai sem imagem\/vídeo/);
    expect(approvalText(item, uiConfig(bundle, []))).not.toMatch(/Sem host de mídia/);
    const semMidia = { ...item, media: [] } as typeof item;
    expect(approvalText(semMidia, ui)).not.toMatch(/Sem host de mídia/);
  });
});
