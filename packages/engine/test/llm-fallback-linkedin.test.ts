import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelsConfig } from "@auto-curator/contracts";
import { LlmClient, Store } from "../src/index.js";

const base = { baseUrl: "https://a.test/v1", apiKeyEnv: "KA", model: "ma", inputUsdPerM: 1, outputUsdPerM: 2, maxTokens: 100 };
const models = ModelsConfig.parse({
  monthlyBudgetBRL: 10,
  roles: { triage: base, curator: { ...base, fallback: { ...base, baseUrl: "https://b.test/v1", apiKeyEnv: "KB", model: "mb" } } },
});
const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
const schema = z.object({ n: z.number() });

/** Primário responde `primaryStatus` (ou não tem chave); o fallback responde {"n":2}. */
function run(opts: { primaryStatus?: number; env?: Record<string, string> }) {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = (async (url: string) => {
    urls.push(url);
    if (url.startsWith("https://a.test")) return new Response("erro", { status: opts.primaryStatus ?? 500 });
    return ok('{"n":2}');
  }) as typeof fetch;
  const store = new Store(":memory:");
  const c = new LlmClient({ models, store, env: opts.env ?? { KA: "a", KB: "b" }, fetch, sleep: async () => {}, maxRetries: 1 });
  return { c, store, urls };
}

describe("L11 — fallback do LLM em 429, 400 e chave ausente", () => {
  it("429 do primário: usa o fallback e registra o uso", async () => {
    const { c, store, urls } = run({ primaryStatus: 429 });
    const r = await c.json({ role: "curator", system: "s", user: "u", schema });
    expect(r.value).toEqual({ n: 2 });
    expect(r.model).toBe("mb");
    expect(urls.some((u) => u.startsWith("https://b.test"))).toBe(true);
    expect(store.monthSpendBRL()).toBeGreaterThan(0);
  });

  it("400 do primário: usa o fallback", async () => {
    const { c, urls } = run({ primaryStatus: 400 });
    const r = await c.json({ role: "curator", system: "s", user: "u", schema });
    expect(r.value).toEqual({ n: 2 });
    expect(urls.some((u) => u.startsWith("https://b.test"))).toBe(true);
  });

  it("chave do primário ausente: pula para o fallback sem chamar o primário", async () => {
    const { c, urls } = run({ env: { KB: "b" } });
    const r = await c.json({ role: "curator", system: "s", user: "u", schema });
    expect(r.value).toEqual({ n: 2 });
    expect(urls.every((u) => u.startsWith("https://b.test"))).toBe(true);
  });
});
