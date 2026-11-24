import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

// fixedClock() = 2026-11-14T15:00:00Z = 12:00 em São Paulo (UTC-3)
const dest = (over: Record<string, unknown>) => ({ platform: "instagram", publisher: "buffer", ...over });
const approveAll = async (dests: Record<string, unknown>[], n: number) => {
  const t = setup({ profile: { destinations: dests } as never });
  const items: string[] = [];
  for (let i = 0; i < n; i++) items.push((await t.app.addManual(`texto ${i} do dia para o buffer`))!.item!.id);
  await t.app.runPipeline();
  const outs = [];
  for (const id of items) outs.push((await t.app.approve(id))[0]!);
  return { t, outs };
};

describe("teto diário adia em vez de virar manual (K12)", () => {
  it("cheio hoje: o segundo item sai no primeiro horário do dia seguinte (09:00 locais)", async () => {
    const { outs } = await approveAll([dest({ dailyCap: 1 })], 2);
    expect(outs[0]).toMatchObject({ kind: "buffer" });
    expect(outs[1]).toMatchObject({ kind: "queued", scheduledAt: "2026-11-15T12:00:00.000Z" });
  });

  it("o terceiro item, com o dia seguinte também cheio, vai para o dia depois", async () => {
    const { outs } = await approveAll([dest({ dailyCap: 1 })], 3);
    expect(outs[1]).toMatchObject({ kind: "queued", scheduledAt: "2026-11-15T12:00:00.000Z" });
    expect(outs[2]).toMatchObject({ kind: "queued", scheduledAt: "2026-11-16T12:00:00.000Z" });
  });

  it("janela: item fora da janela espera e sai no início dela (13:00 locais = 16:00Z)", async () => {
    const { outs } = await approveAll([dest({ dailyCap: 4, window: { start: "13:00", end: "16:00" } })], 1);
    expect(outs[0]).toMatchObject({ kind: "queued", scheduledAt: "2026-11-14T16:00:00.000Z" });
  });

  it("sem vaga em maxDeferDays: vai para manual com a nota", async () => {
    const { outs } = await approveAll([dest({ dailyCap: 1, maxDeferDays: 0 })], 2);
    expect(outs[1]).toMatchObject({ kind: "manual" });
    expect(outs[1]!.error).toBe("sem vaga nos próximos 0 dias (teto diário de 1)");
  });
});
