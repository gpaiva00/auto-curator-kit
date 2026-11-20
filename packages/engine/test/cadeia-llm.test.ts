import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelsConfig } from "@auto-curator/contracts";
import { BudgetExceededError, LlmClient, MissingApiKeyError, Store, costBRL, describeChain, resolveRoleChain } from "../src/index.js";

const groq = { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", model: "modelo-groq", inputUsdPerM: 1, outputUsdPerM: 2, maxTokens: 100 };
const deepseek = { baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", model: "modelo-deepseek", inputUsdPerM: 1, outputUsdPerM: 2, maxTokens: 100 };
const openrouter = { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", model: "modelo-openrouter", inputUsdPerM: 5, outputUsdPerM: 10, maxTokens: 100 };
const models = (budget = 10) =>
  ModelsConfig.parse({
    monthlyBudgetBRL: budget,
    roles: { triage: { ...groq, fallback: [deepseek, openrouter] }, curator: { ...groq, fallback: [deepseek, openrouter] } },
  });
const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
const schema = z.object({ n: z.number() });

describe("cadeia de LLM por papel: regra única (resolveRoleChain)", () => {
  it("primeiro provider sem chave e segundo com chave: o segundo fica ativo; o primeiro sai", () => {
    const chain = resolveRoleChain(models(), { DEEPSEEK_API_KEY: "k" }).triage;
    expect(chain.active.map((p) => p.envName)).toEqual(["DEEPSEEK_API_KEY"]);
    expect(chain.skipped.map((p) => p.envName)).toEqual(["GROQ_API_KEY", "OPENROUTER_API_KEY"]);
    expect(describeChain(chain)).toBe("triage: ativo deepseek/modelo-deepseek; pulados: groq (GROQ_API_KEY ausente), openrouter (OPENROUTER_API_KEY ausente)");
  });

  it("log sem valores: nunca aparece o valor de uma chave", () => {
    const line = describeChain(resolveRoleChain(models(), { DEEPSEEK_API_KEY: "SEGREDO-VALOR" }).triage);
    expect(line).not.toContain("SEGREDO-VALOR");
  });

  it("cadeia sem nenhuma chave: não ativa nada e lista todas as variáveis aceitas", () => {
    const chain = resolveRoleChain(models(), {}).triage;
    expect(chain.active).toEqual([]);
    expect(chain.acceptedEnvs).toEqual(["GROQ_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"]);
  });
});

describe("chamada: o LlmClient nunca tenta um provider sem chave", () => {
  it("primeiro sem chave e segundo com chave: só o segundo recebe a chamada", async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = (async (url: string) => (urls.push(url), ok('{"n":2}'))) as typeof fetch;
    const c = new LlmClient({ models: models(), store: new Store(":memory:"), env: { DEEPSEEK_API_KEY: "k" }, fetch, sleep: async () => {}, maxRetries: 1 });
    const r = await c.json({ role: "triage", system: "s", user: "u", schema });
    expect(r.value).toEqual({ n: 2 });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/api\.deepseek\.com/);
  });

  it("cadeia sem nenhuma chave: falha com MissingApiKeyError listando as variáveis aceitas, sem chamar a rede", async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = (async (url: string) => (urls.push(url), ok('{"n":1}'))) as typeof fetch;
    const c = new LlmClient({ models: models(), store: new Store(":memory:"), env: {}, fetch, sleep: async () => {}, maxRetries: 1 });
    const err = await c.json({ role: "triage", system: "s", user: "u", schema }).catch((e) => e);
    expect(err).toBeInstanceOf(MissingApiKeyError);
    expect(err.message).toMatch(/GROQ_API_KEY ou DEEPSEEK_API_KEY ou OPENROUTER_API_KEY/);
    expect(urls).toHaveLength(0);
  });
});

describe("teto de gasto: o kit tenta o fallback que couber", () => {
  const cheap = { ...groq, inputUsdPerM: 0.001, outputUsdPerM: 0.001 };
  const pricey = { ...openrouter, inputUsdPerM: 1_000_000, outputUsdPerM: 1_000_000 };

  it("principal caro demais e fallback barato cabe: o fallback é chamado e o gasto registrado é o dele", async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = (async (url: string) => (urls.push(url), ok('{"n":2}'))) as typeof fetch;
    const m = ModelsConfig.parse({ monthlyBudgetBRL: 1, roles: { triage: { ...pricey, fallback: cheap }, curator: { ...cheap } } });
    const store = new Store(":memory:");
    const c = new LlmClient({ models: m, store, env: { OPENROUTER_API_KEY: "o", GROQ_API_KEY: "g" }, fetch, sleep: async () => {}, maxRetries: 0 });
    const r = await c.json({ role: "triage", system: "s", user: "u", schema });
    expect(r.value).toEqual({ n: 2 });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/api\.groq\.com/);
    expect(store.monthSpendBRL()).toBeCloseTo(costBRL(cheap, m.usdBrl, 10, 5), 10);
  });

  it("nenhum provider cabe no teto: BudgetExceededError e nenhuma requisição", async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = (async (url: string) => (urls.push(url), ok('{"n":2}'))) as typeof fetch;
    const m = ModelsConfig.parse({ monthlyBudgetBRL: 1, roles: { triage: { ...pricey, fallback: pricey }, curator: { ...cheap } } });
    const c = new LlmClient({ models: m, store: new Store(":memory:"), env: { OPENROUTER_API_KEY: "o" }, fetch, sleep: async () => {}, maxRetries: 0 });
    const err = await c.json({ role: "triage", system: "s", user: "u", schema }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(urls).toHaveLength(0);
  });

  it("fallback respondendo: o gasto registrado usa o preço do fallback, não o do principal", async () => {
    const store = new Store(":memory:");
    const fetch: typeof globalThis.fetch = (async (url: string) => (url.startsWith("https://api.groq") ? new Response("erro", { status: 500 }) : ok('{"n":2}'))) as typeof fetch;
    const m = models(50);
    const c = new LlmClient({ models: m, store, env: { GROQ_API_KEY: "g", DEEPSEEK_API_KEY: "d" }, fetch, sleep: async () => {}, maxRetries: 0 });
    await c.json({ role: "triage", system: "s", user: "u", schema });
    expect(store.monthSpendBRL()).toBeCloseTo(costBRL(deepseek, m.usdBrl, 10, 5), 10);
  });
});
