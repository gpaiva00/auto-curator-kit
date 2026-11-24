import { describe, expect, it } from "vitest";
import { FakeLlm, okDraft } from "../src/testing.js";
import { setup } from "./helpers.js";

const threads = [{ platform: "threads", publisher: "buffer", mode: "draft", dailyCap: 4, only: "any" }];

describe("limite do destino na geração (B)", () => {
  it("passa do limite na 1ª tentativa e cabe na 2ª: o rascunho vai para aprovação com o pedido de encurtar", async () => {
    const llm = new FakeLlm({ curator: [okDraft({ body: "a".repeat(600) }), okDraft({ body: "b".repeat(300) })] });
    const t = setup({ llm, profile: { destinations: threads } as never });
    const a = (await t.app.addManual("texto de teste para o limite do threads"))!.item!;
    await t.app.runPipeline();
    const d = t.store.get(a.id)!.draft!;
    expect(d.verdict).toBe("publish");
    const curator = t.llm.calls.filter((c) => c.role === "curator");
    expect(curator).toHaveLength(2);
    expect(curator[1]!.user).toContain("o máximo é 500");
  });

  it("passa nas duas tentativas: não corta o texto e marca needs_human com a contagem", async () => {
    const llm = new FakeLlm({ curator: [okDraft({ body: "a".repeat(600) }), okDraft({ body: "b".repeat(700) })] });
    const t = setup({ llm, profile: { destinations: threads } as never });
    const a = (await t.app.addManual("texto de teste para o limite do threads"))!.item!;
    await t.app.runPipeline();
    const d = t.store.get(a.id)!.draft!;
    expect(d.verdict).toBe("needs_human");
    expect(d.body).toBe("b".repeat(700)); // não cortado
    expect(d.notes).toMatch(/threads: \d+\/500 caracteres, acima do limite/);
    expect(t.llm.calls.filter((c) => c.role === "curator")).toHaveLength(2);
  });

  it("sem destino com limite: uma só chamada ao curador, como antes", async () => {
    const llm = new FakeLlm({ curator: okDraft({ body: "a".repeat(600) }) });
    const t = setup({ llm });
    const a = (await t.app.addManual("texto de teste sem limite de destino"))!.item!;
    await t.app.runPipeline();
    expect(t.store.get(a.id)!.draft!.verdict).toBe("publish");
    expect(t.llm.calls.filter((c) => c.role === "curator")).toHaveLength(1);
  });
});
