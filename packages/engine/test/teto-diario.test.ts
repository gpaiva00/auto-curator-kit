import { describe, expect, it } from "vitest";
import type { JsonRequest, RawItem } from "@auto-curator/contracts";
import { BudgetExceededError } from "../src/index.js";
import { FakeLlm, FakeSource, okDraft } from "../src/testing.js";
import { setup } from "./helpers.js";

// fixedClock() = 2026-11-14T15:00:00Z
const feed = (id: string): RawItem => ({
  dedupeKey: `feed:${id}`, origin: "feed", source: "fake", author: `Fonte ${id}`, title: `Assunto ${id}`,
  text: "Texto da fonte com detalhes suficientes para a triagem e a curadoria.", sourceUrl: `https://example.com/${id}`,
  postedAt: "2026-11-14T13:00:00.000Z", engagement: { likes: 10 }, media: [], extra: {},
});

/** Dois itens pontuados (A acima de B); o curador responde na ordem da curadoria. */
function dois(curator: unknown[]) {
  const llm = new FakeLlm({
    triage: (req: JsonRequest<unknown>) => {
      const p = JSON.parse(req.user) as { items: { id: string; title?: string | null }[] };
      return p.items.map((i) => ({ id: i.id, score: i.title?.includes("A") ? 90 : 80, reason: "relevante" }));
    },
    curator,
  });
  return setup({
    llm,
    profile: { pipeline: { dailyApprovalCap: 1, curatorPerTick: 3 } },
    sources: [new FakeSource("fake", [feed("A"), feed("B")])],
  });
}

describe("teto diário: a vaga volta no mesmo ciclo quando o item em voo termina em skip ou falha", () => {
  // REGRESSÃO: este teste passa também sem a correção de falha, porque skip já liberava a vaga antes.
  it("regressão (skip já liberava a vaga antes da correção): A é descartado e B é curado no mesmo tick", async () => {
    const t = dois([okDraft({ verdict: "skip", skipReason: "fora do tema" }), okDraft()]);
    await t.app.ingest();
    await t.app.tick();
    const items = t.store.list(["skipped", "curated", "ready", "pending_approval", "scored", "new"]);
    const byTitle = (s: string) => items.find((i) => i.title === s);
    expect(byTitle("Assunto A")?.status).toBe("skipped");
    // B foi curado e, no mesmo tick, apresentado: já passou de scored
    expect(["curated", "ready", "pending_approval"]).toContain(byTitle("Assunto B")?.status);
  });

  it("falha comum do curador em A (prova da correção): B é curado no mesmo tick", async () => {
    const t = dois([new Error("curador indisponível"), okDraft()]);
    await t.app.ingest();
    await t.app.tick();
    const items = t.store.list(["skipped", "curated", "ready", "pending_approval", "scored", "new"]);
    const byTitle = (s: string) => items.find((i) => i.title === s);
    expect(["curated", "ready", "pending_approval"]).toContain(byTitle("Assunto B")?.status);
    expect(t.store.get(byTitle("Assunto A")!.id)?.attempts).toBe(1);
  });
});

describe("teto de orçamento: só ele interrompe a curadoria do tick", () => {
  it("BudgetExceededError no A: o B NÃO é curado no ciclo (o teto de orçamento para o tick)", async () => {
    const t = dois([new BudgetExceededError(1, 2, 3), okDraft()]);
    await t.app.ingest();
    await t.app.tick();
    const items = t.store.list(["scored", "new", "skipped", "curated", "ready", "pending_approval"]);
    const byTitle = (s: string) => items.find((i) => i.title === s);
    expect(byTitle("Assunto B")?.status).toBe("scored");
    expect(t.llm.calls.filter((c) => c.role === "curator")).toHaveLength(1);
  });
});
