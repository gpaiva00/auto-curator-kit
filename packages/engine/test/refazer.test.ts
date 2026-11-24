import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const texto = "texto de teste para o refazer do item aprovado";

describe("/refazer (C)", () => {
  it("aprovado sem nenhuma publicação na fila (só manual) volta à aprovação e é refeito", async () => {
    const t = setup({ profile: { destinations: [{ platform: "instagram", publisher: "manual", dailyCap: 4 }] } as never });
    const a = (await t.app.addManual(texto))!.item!;
    await t.app.runPipeline();
    await t.app.approve(a.id);
    expect(t.store.get(a.id)!.status).toBe("approved");
    await t.app.refazer(a.id, "mais curto");
    expect(t.store.get(a.id)!.status).toBe("pending_approval");
    expect(t.store.approvalsOf(a.id)).toEqual(expect.arrayContaining([expect.objectContaining({ action: "regenerate", reason: "mais curto" })]));
  });

  it("aprovado com publicação na fila (agendada no Buffer) é recusado com a mensagem clara e não muda nada", async () => {
    const t = setup({ profile: { destinations: [{ platform: "instagram", publisher: "buffer", dailyCap: 4 }] } as never });
    const a = (await t.app.addManual(texto))!.item!;
    await t.app.runPipeline();
    await t.app.approve(a.id);
    await expect(t.app.refazer(a.id, "mais curto")).rejects.toThrow("Este item já está na fila de envio; não dá para refazer sem cancelar antes.");
    expect(t.store.get(a.id)!.status).toBe("published"); // Buffer agendou: o item já está "published" pelo fluxo atual
    expect(t.buffer.requests).toHaveLength(1);
  });

  it("publicado é recusado com mensagem clara", async () => {
    const t = setup({ profile: { destinations: [{ platform: "instagram", publisher: "manual", dailyCap: 4 }] } as never });
    const a = (await t.app.addManual(texto))!.item!;
    await t.app.runPipeline();
    await t.app.approve(a.id);
    await t.app.markPublished(a.id, "instagram");
    expect(t.store.get(a.id)!.status).toBe("published");
    await expect(t.app.refazer(a.id, "x")).rejects.toThrow("Este item já foi publicado; não dá para refazer.");
  });
});
