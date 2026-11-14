import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelsConfig } from "@auto-curator/contracts";
import { BudgetExceededError, LlmClient, LlmOutputError, Store } from "../src/index.js";

const base = { baseUrl: "https://a.test/v1", apiKeyEnv: "KA", model: "ma", inputUsdPerM: 1, outputUsdPerM: 2, maxTokens: 100 };
const models = (budget = 10, fallback = true) =>
  ModelsConfig.parse({ monthlyBudgetBRL: budget, roles: { triage: base, curator: { ...base, fallback: fallback ? { ...base, baseUrl: "https://b.test/v1", apiKeyEnv: "KB", model: "mb" } : undefined } } });

const reply = (content: string, status = 200) => new Response(status === 200 ? JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }) : "err", { status });
const schema = z.object({ n: z.number() });

function client(fetchFn: typeof fetch, m = models()) {
  const store = new Store(":memory:");
  const c = new LlmClient({ models: m, store, env: { KA: "a", KB: "b" }, fetch: fetchFn, sleep: async () => {}, maxRetries: 1 });
  return { c, store };
}

describe("llm", () => {
  it("parses JSON (fenced), records usage and cost", async () => {
    const { c, store } = client((async () => reply('```json\n{"n":1}\n```')) as typeof fetch);
    const r = await c.json({ role: "curator", system: "s", user: "u", schema });
    expect(r.value).toEqual({ n: 1 });
    expect(r.model).toBe("ma");
    expect(store.monthSpendBRL()).toBeGreaterThan(0);
  });

  it("falls back to the next model on 5xx", async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      return url.startsWith("https://a.test") ? reply("", 503) : reply('{"n":2}');
    }) as unknown as typeof fetch;
    const { c } = client(f);
    const r = await c.json({ role: "curator", system: "s", user: "u", schema });
    expect(r.model).toBe("mb");
    expect(urls.some((u) => u.startsWith("https://b.test"))).toBe(true);
  });

  it("retries once on invalid JSON, then throws LlmOutputError", async () => {
    let n = 0;
    const ok = client((async () => (++n === 1 ? reply("not json") : reply('{"n":3}'))) as typeof fetch);
    expect((await ok.c.json({ role: "curator", system: "s", user: "u", schema })).value.n).toBe(3);
    expect(n).toBe(2);
    n = 0;
    const bad = client((async () => (n++, reply("nope"))) as typeof fetch);
    await expect(bad.c.json({ role: "curator", system: "s", user: "u", schema })).rejects.toBeInstanceOf(LlmOutputError);
    expect(n).toBe(2);
  });

  it("refuses calls past the monthly budget without fetching", async () => {
    let called = 0;
    const { c, store } = client((async () => (called++, reply('{"n":1}'))) as typeof fetch, models(1));
    store.recordUsage({ role: "curator", model: "m", inputTokens: 0, outputTokens: 0, costBRL: 1, ok: true });
    await expect(c.json({ role: "curator", system: "s", user: "u", schema })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(called).toBe(0);
  });

  it("unwraps arrays for triage", async () => {
    const { unwrapArray } = await import("../src/index.js");
    expect(unwrapArray({ items: [1, 2] })).toEqual([1, 2]);
  });
});
