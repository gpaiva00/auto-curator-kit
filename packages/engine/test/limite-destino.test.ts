import { describe, expect, it } from "vitest";
import { FakeLlm, okDraft } from "../src/testing.js";
import { setup } from "./helpers.js";

/** Aprova um item com um destino de Buffer e devolve o que o Buffer recebeu e o registro. */
async function aprovar(body: string, destinations: unknown[]) {
  const t = setup({ llm: new FakeLlm({ curator: okDraft({ body, hashtags: [], sourceCredit: undefined }) }), profile: { destinations: destinations as never, editorial: { credit: "hide" } as never } });
  const a = (await t.app.addManual("texto manual para testar o limite por destino"))!.item!;
  await t.app.runPipeline();
  const out = await t.app.approve(a.id);
  return { t, out, id: a.id, sent: t.buffer.requests.map((r) => r.destination.platform) };
}

describe("limite de caracteres por destino (engine)", () => {
  it("Threads por Buffer sem maxChars usa 500: texto de 501 vai para manual com a nota, sem chamar o publicador", async () => {
    const { t, out, id, sent } = await aprovar("a".repeat(501), [
      { platform: "linkedin", publisher: "buffer", mode: "draft" },
      { platform: "threads", publisher: "buffer", mode: "draft" },
    ]);
    expect(sent).toEqual(["linkedin"]);
    expect(out.find((o) => o.platform === "threads")).toMatchObject({ kind: "manual", error: "texto de 501 caracteres passa do limite de 500" });
    expect(t.store.publicationsOf(id).find((r) => r.platform === "threads")).toMatchObject({ publisher: "manual", status: "manual" });
  });

  it("maxChars presente é o limite: 301 passa do limite de 300, 300 passa", async () => {
    const over = await aprovar("a".repeat(301), [{ platform: "x", publisher: "buffer", mode: "draft", maxChars: 300 }]);
    expect(over.sent).toEqual([]);
    expect(over.out[0]).toMatchObject({ kind: "manual", error: "texto de 301 caracteres passa do limite de 300" });

    const fits = await aprovar("a".repeat(300), [{ platform: "x", publisher: "buffer", mode: "draft", maxChars: 300 }]);
    expect(fits.sent).toEqual(["x"]);
  });

  it("conta pontos de código, não unidades UTF-16: 300 emojis cabem em 300", async () => {
    const { sent, out } = await aprovar("😀".repeat(300), [{ platform: "x", publisher: "buffer", mode: "draft", maxChars: 300 }]);
    expect(sent).toEqual(["x"]);
    expect(out[0]).toMatchObject({ kind: "buffer" });
  });
});
