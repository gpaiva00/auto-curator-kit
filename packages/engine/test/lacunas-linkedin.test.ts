import { describe, expect, it } from "vitest";
import type { RawItem } from "@auto-curator/contracts";
import type { JsonRequest } from "@auto-curator/contracts";
import { FakeLlm, FakeSource, okDraft } from "../src/testing.js";
import { setup } from "./helpers.js";

// fixedClock() = 2026-11-14T15:00:00Z
const feed = (id: string, postedAt: string, title = "Assunto do dia"): RawItem => ({
  dedupeKey: `feed:${id}`, origin: "feed", source: "fake", author: "Fonte", title, text: "Texto da fonte com detalhes suficientes para a triagem.",
  sourceUrl: `https://example.com/${id}`, postedAt, engagement: { likes: 10 }, media: [], extra: {},
});

describe("L5 — maxItemAgeHours: item antigo vira skipped antes da triagem", () => {
  it("post de 48h com limite de 24h é gravado como skipped, sem chamar a IA", async () => {
    const old = feed("antigo", "2026-11-12T15:00:00.000Z");
    const t = setup({ profile: { pipeline: { maxItemAgeHours: 24 } }, sources: [new FakeSource("fake", [old])] });
    await t.app.ingest();
    await t.app.tick();
    expect(t.store.countsByStatus()).toMatchObject({ skipped: 1 });
    expect(t.llm.calls.filter((c) => c.role === "triage")).toHaveLength(0);
  });

  it("post de 2h passa pelo limite e segue para a triagem", async () => {
    const recent = feed("novo", "2026-11-14T13:00:00.000Z");
    const t = setup({ profile: { pipeline: { maxItemAgeHours: 24 } }, sources: [new FakeSource("fake", [recent])] });
    await t.app.ingest();
    await t.app.tick();
    expect(t.llm.calls.filter((c) => c.role === "triage").length).toBeGreaterThan(0);
  });
});

describe("L12 — triagem: nota 0-1 vira 0-100", () => {
  it("score 0.9 da IA vira 90 no item e passa do mínimo de triagem (60)", async () => {
    const llm = new FakeLlm({
      triage: (req: JsonRequest<unknown>) => {
        const p = JSON.parse(req.user) as { items: { id: string }[] };
        return p.items.map((i) => ({ id: i.id, score: 0.9, reason: "relevante" }));
      },
      curator: okDraft(),
    });
    const t = setup({ llm, sources: [new FakeSource("fake", [feed("um", "2026-11-14T13:00:00.000Z")])] });
    await t.app.ingest();
    await t.app.tick();
    const [item] = t.store.list(["scored", "curated", "ready", "pending_approval", "approved", "published"]);
    expect(item?.score).toBe(90);
  });

  it("score 0.5 da IA vira 50 e fica abaixo do mínimo: o item é descartado na triagem", async () => {
    const llm = new FakeLlm({
      triage: (req: JsonRequest<unknown>) => {
        const p = JSON.parse(req.user) as { items: { id: string }[] };
        return p.items.map((i) => ({ id: i.id, score: 0.5, reason: "fraco" }));
      },
      curator: okDraft(),
    });
    const t = setup({ llm, sources: [new FakeSource("fake", [feed("dois", "2026-11-14T13:00:00.000Z")])] });
    await t.app.ingest();
    await t.app.tick();
    expect(t.store.countsByStatus()).toMatchObject({ skipped: 1 });
    expect(t.llm.calls.filter((c) => c.role === "curator")).toHaveLength(0);
  });
});

describe("L13 — /add recusa duplicata", () => {
  it("o mesmo texto adicionado duas vezes: a segunda é recusada com mensagem", async () => {
    const t = setup();
    const first = await t.app.addManual("texto manual repetido para testar a duplicata");
    expect(first.item).toBeDefined();
    const second = await t.app.addManual("texto manual repetido para testar a duplicata");
    expect(second.item).toBeUndefined();
    expect(second.error).toMatch(/já foi adicionado/);
  });

  it("o mesmo link colado duas vezes também é recusado", async () => {
    const link = "https://example.com/materia-x";
    const t = setup({ sources: [new FakeSource("fake", [], { fromInput: () => feed("link", "2026-11-14T13:00:00.000Z") })] });
    const first = await t.app.addManual(link);
    expect(first.item).toBeDefined();
    const second = await t.app.addManual(link);
    expect(second.error).toMatch(/já foi adicionado/);
  });
});
