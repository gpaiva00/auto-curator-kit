import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULED_LIMIT,
  ESTEIRA_CAPACITY_ACTION,
  KIT_CAPACITY_ACTION,
  MAX_PAGES,
  QUEUE_READ_ERR,
  bufferLastDue,
  bufferQueueInfo,
  capacityCheck,
  readQueueOrThrow,
  readScheduledLimit,
  type GqlFn,
} from "../src/buffer-capacity.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-21T12:00:00Z");
const fill = (n: number, start = Date.parse("2026-11-22T13:30:00Z")) =>
  Array.from({ length: n }, (_, i) => new Date(start + i * DAY).toISOString());

const page = (dueAts: string[], more?: { hasNextPage: boolean; endCursor: string | null }) => ({
  posts: { edges: dueAts.map((dueAt) => ({ node: { dueAt } })), pageInfo: more ?? { hasNextPage: false, endCursor: null } },
});

describe("capacityCheck (portado da esteira, 7c)", () => {
  it("tabela de contagem e limite, incluindo limite inválido", () => {
    const cases: [number, number | null | undefined, boolean][] = [
      [0, 10, true],
      [9, 10, true],
      [10, 10, false],
      [11, 10, false],
      [10, null, false],
      [10, undefined, false],
      [9, null, true],
      [10, 0, false],
    ];
    for (const [count, limit, ok] of cases) expect(capacityCheck({ count, limit, now: NOW }).ok, `${count} de ${String(limit)}`).toBe(ok);
  });

  it("no limite recusa com a frase do kit (sem próxima vaga)", () => {
    const r = capacityCheck({ count: 10, limit: 10, now: NOW });
    expect(r).toEqual({ ok: false, message: `Fila do Buffer cheia: 10 de 10 agendados. ${KIT_CAPACITY_ACTION}` });
  });

  it("a frase de ação é parametrizável: com a da esteira, a mensagem é a da esteira", () => {
    const r = capacityCheck({ count: 10, limit: 10, now: NOW, action: ESTEIRA_CAPACITY_ACTION });
    expect(r.message).toBe("Fila do Buffer cheia: 10 de 10 agendados. Toque de novo quando um post sair.");
  });

  it("mensagem com a próxima vaga, no fuso de Brasília", () => {
    const r = capacityCheck({ count: 10, limit: 10, earliestDueAt: Date.parse("2026-11-27T13:30:00Z"), now: NOW });
    expect(r.message).toBe(`Fila do Buffer cheia: 10 de 10 agendados. ${KIT_CAPACITY_ACTION} Próxima vaga: 27/11 às 10:30 (Brasília).`);
  });

  it("não anuncia vaga que já passou", () => {
    const r = capacityCheck({ count: 10, limit: 10, earliestDueAt: NOW - DAY, now: NOW });
    expect(r.message).toBe(`Fila do Buffer cheia: 10 de 10 agendados. ${KIT_CAPACITY_ACTION}`);
  });

  it("abaixo do limite libera e não tem mensagem", () => {
    expect(capacityCheck({ count: 9, limit: 10, now: NOW })).toEqual({ ok: true, message: "" });
  });

  it("limite inválido cai em DEFAULT_SCHEDULED_LIMIT (10)", () => {
    expect(DEFAULT_SCHEDULED_LIMIT).toBe(10);
    expect(capacityCheck({ count: 10, limit: Number.NaN }).ok).toBe(false);
  });
});

describe("bufferQueueInfo: fila paginada do canal", () => {
  it("devolve o maior dueAt, a contagem e o próximo a sair", async () => {
    const gqlFn: GqlFn = async () => page(fill(3));
    expect(await bufferQueueInfo("o", "c", "k", gqlFn)).toEqual({
      lastDue: Date.parse(fill(3)[2]!),
      count: 3,
      earliestDueAt: Date.parse(fill(3)[0]!),
    });
  });

  it("fila vazia devolve zeros", async () => {
    expect(await bufferLastDue("o", "c", "k", async () => page([]))).toBe(0);
  });

  it("pagina até a última página e usa o cursor", async () => {
    const seen: string[] = [];
    const gqlFn: GqlFn = async (query) => {
      seen.push(query);
      if (!query.includes("after:")) return page(fill(1, Date.parse("2026-11-22T13:30:00Z")), { hasNextPage: true, endCursor: "c1" });
      return page(fill(1, Date.parse("2026-11-30T13:30:00Z")));
    };
    const r = await bufferQueueInfo("o", "c", "k", gqlFn);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('after: "c1"');
    expect(r).toEqual({ lastDue: Date.parse("2026-11-30T13:30:00Z"), count: 2, earliestDueAt: Date.parse("2026-11-22T13:30:00Z") });
  });

  it("resposta fora do formato, dueAt inválido ou paginação sem cursor lançam erro", async () => {
    await expect(bufferLastDue("o", "c", "k", async () => ({}))).rejects.toThrow(/resposta inesperada/);
    await expect(
      bufferLastDue("o", "c", "k", async () => ({ posts: { edges: [{ node: { dueAt: "nada" } }], pageInfo: { hasNextPage: false } } })),
    ).rejects.toThrow(/dueAt inválido/);
    await expect(
      bufferLastDue("o", "c", "k", async () => ({ posts: { edges: [], pageInfo: { hasNextPage: true, endCursor: null } } })),
    ).rejects.toThrow(/sem cursor/);
  });

  it("para depois de MAX_PAGES em vez de paginar para sempre", async () => {
    const gqlFn: GqlFn = async () => page([], { hasNextPage: true, endCursor: "x" });
    await expect(bufferQueueInfo("o", "c", "k", gqlFn)).rejects.toThrow(/fila grande demais/);
    expect(MAX_PAGES).toBe(50);
  });

  it("a query leva organização, canal, status e ordenação por dueAt", async () => {
    let q = "";
    await bufferQueueInfo("org-1", "chan-9", "k", async (query) => {
      q = query;
      return page([]);
    });
    expect(q).toContain('organizationId: "org-1"');
    expect(q).toContain('channelIds: ["chan-9"]');
    expect(q).toContain("status: [scheduled, sending]");
    expect(q).toContain("field: dueAt, direction: desc");
    expect(q).toContain("first: 100");
  });
});

describe("readScheduledLimit", () => {
  const respond = (orgs: unknown): GqlFn => async () => ({ account: { organizations: orgs } });

  it("lê limits.scheduledPosts da organização certa", async () => {
    expect(await readScheduledLimit("o1", "k", respond([{ id: "o0", limits: { scheduledPosts: 3 } }, { id: "o1", limits: { scheduledPosts: 10 } }]))).toBe(10);
  });

  it("organização ausente, limite inválido ou resposta estranha devolvem null (quem chama usa 10)", async () => {
    expect(await readScheduledLimit("o1", "k", respond([{ id: "o2", limits: { scheduledPosts: 10 } }]))).toBeNull();
    for (const v of [0, -1, "10", null, Number.NaN]) {
      expect(await readScheduledLimit("o1", "k", respond([{ id: "o1", limits: { scheduledPosts: v } }]))).toBeNull();
    }
    expect(await readScheduledLimit("o1", "k", async () => ({}))).toBeNull();
  });
});

describe("readQueueOrThrow: leitura falhou, não adivinha", () => {
  it("qualquer falha vira o erro em português", async () => {
    const ch = { id: "c", orgId: "o", key: "k" };
    await expect(
      readQueueOrThrow(ch, async () => {
        throw new Error("401 simulado");
      }),
    ).rejects.toThrow(QUEUE_READ_ERR);
    await expect(readQueueOrThrow(ch, async () => ({}))).rejects.toThrow(QUEUE_READ_ERR);
  });

  it("sucesso passa o resultado adiante", async () => {
    const ch = { id: "c", orgId: "o", key: "k" };
    expect(await readQueueOrThrow(ch, async () => page(fill(2)))).toMatchObject({ count: 2 });
  });
});
