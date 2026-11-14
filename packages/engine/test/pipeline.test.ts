import { describe, expect, it } from "vitest";
import { KitError } from "@auto-curator/contracts";
import { FakeLlm, FakeSource, LlmOutputError, Scheduler, okDraft } from "../src/index.js";
import { setup } from "./helpers.js";

const dests = [
  { platform: "instagram", publisher: "buffer", mode: "draft" },
  { platform: "linkedin", publisher: "manual" },
];

describe("pipeline with fakes", () => {
  it("manual item -> pending_approval -> approve -> buffer + manual -> markPublished -> published", async () => {
    const t = setup({ profile: { destinations: dests as never } });
    const { item } = await t.app.addManual("Um texto manual bem interessante sobre algo");
    expect(item!.status).toBe("new");
    await t.app.runPipeline();
    expect(t.store.get(item!.id)!.status).toBe("pending_approval");
    expect(t.notifier.approvals).toHaveLength(1);
    expect(t.store.get(item!.id)!.prepared).toHaveLength(1);
    expect(t.llm.calls.map((c) => c.role)).toEqual(["curator"]); // no triage for manual

    const out = await t.app.approve(item!.id);
    expect(out.map((o) => o.kind)).toEqual(["buffer", "manual"]);
    expect(t.buffer.requests).toHaveLength(1);
    expect(t.buffer.requests[0]!.text).toContain("#teste");
    expect(t.store.get(item!.id)!.status).toBe("approved");
    expect(t.store.publicationsOf(item!.id).map((p) => p.status)).toEqual(["scheduled", "manual"]);
    expect((await t.app.agenda())[0]!.platform).toBe("instagram");

    await t.app.markPublished(item!.id, "linkedin");
    expect(t.store.get(item!.id)!.status).toBe("published");
    expect(t.store.approvalsOf(item!.id).map((a) => a.action)).toEqual(["approve", "published_manual"]);
  });

  it("all-buffer destinations publish immediately; buffer failure falls back to manual", async () => {
    const ok = setup({ profile: { destinations: [{ platform: "instagram", publisher: "buffer" }] } as never });
    const a = (await ok.app.addManual("texto para o buffer funcionar bem"))!.item!;
    await ok.app.runPipeline();
    await ok.app.approve(a.id);
    expect(ok.store.get(a.id)!.status).toBe("published");

    const bad = setup({ profile: { destinations: [{ platform: "instagram", publisher: "buffer" }] } as never });
    bad.buffer.failWith = new Error("boom");
    const b = (await bad.app.addManual("texto para o buffer falhar feio"))!.item!;
    await bad.app.runPipeline();
    const out = await bad.app.approve(b.id);
    expect(out[0]).toMatchObject({ kind: "failed", error: "boom" });
    expect(bad.store.get(b.id)!.status).toBe("approved");
    await bad.app.markPublished(b.id, "instagram");
    expect(bad.store.get(b.id)!.status).toBe("published");
  });

  it("respects destination.only", async () => {
    const t = setup({ media: "image", profile: { destinations: [{ platform: "tiktok", publisher: "manual", only: "video" }, { platform: "linkedin", publisher: "manual" }] } as never });
    const a = (await t.app.addManual("texto qualquer para testar destinos"))!.item!;
    await t.app.runPipeline();
    const out = await t.app.approve(a.id);
    expect(out.map((o) => o.platform)).toEqual(["linkedin"]);
  });

  it("feed item: ingest -> triage -> curate -> present; low score is skipped; sources isolated", async () => {
    const llm = new FakeLlm({
      triage: (req: { user: string }) => ({ items: (JSON.parse(req.user).items as { id: string; text: string }[]).map((i) => ({ id: i.id, score: i.text.includes("bom") ? 80 : 10, reason: "r" })) }),
      curator: okDraft(),
    });
    const src = new FakeSource("rss", [
      { dedupeKey: "1", origin: "feed", source: "rss", author: "a", text: "conteudo bom", engagement: { likes: 5 } },
      { dedupeKey: "2", origin: "feed", source: "rss", author: "b", text: "conteudo ruim" },
      { dedupeKey: "3", origin: "feed", source: "rss", author: "c", text: "COMPRE AGORA bom" },
    ]);
    const broken = new FakeSource("broken", [], { fail: new Error("down") });
    const t = setup({ llm, sources: [broken, src], profile: { editorial: { blockedPatterns: ["compre agora"] } } as never });
    const summary = await t.app.ingestNow();
    expect(summary).toContain("broken (down)");
    expect(t.store.count("new")).toBe(2);
    await t.app.tick();
    expect(t.store.count("skipped")).toBe(2); // blocked + low score
    expect(t.store.count("pending_approval")).toBe(1);
    expect((await t.app.ingestNow()).includes("repetidos")).toBe(true);
    expect(t.store.count("new")).toBe(0);
  });

  it("curator skip: manual item notifies, feed item does not", async () => {
    const t = setup({ llm: new FakeLlm({ curator: okDraft({ verdict: "skip", skipReason: "irrelevante" }) }) });
    const a = (await t.app.addManual("manual descartavel qualquer coisa"))!.item!;
    await t.app.tick();
    expect(t.store.get(a.id)!.status).toBe("skipped");
    expect(t.notifier.notices[0]).toContain("irrelevante");
  });

  it("invalid curator output retries until maxAttempts then skips", async () => {
    const t = setup({ llm: new FakeLlm({ curator: new LlmOutputError("bad", "") }), profile: { pipeline: { maxAttempts: 2 } } as never });
    const a = (await t.app.addManual("texto que o curador nao consegue"))!.item!;
    await t.app.tick();
    expect(t.store.get(a.id)!.status).toBe("new");
    await t.app.tick();
    expect(t.store.get(a.id)!.status).toBe("skipped");
  });

  it("regenerate re-runs the curator with feedback and re-sends; reprepare re-sends", async () => {
    const llm = new FakeLlm({ curator: [okDraft({ headline: "v1" }), okDraft({ headline: "v2" })] });
    const t = setup({ llm });
    const a = (await t.app.addManual("texto para refazer depois de pronto"))!.item!;
    await t.app.tick();
    await t.app.regenerate(a.id, "mais curto");
    const cur = t.store.get(a.id)!;
    expect(cur.status).toBe("pending_approval");
    expect(cur.draft!.headline).toBe("v2");
    expect(JSON.parse(llm.calls[1]!.user).feedback).toBe("mais curto");
    expect(t.notifier.approvals).toHaveLength(2);
    expect(t.store.approvalsOf(a.id)).toEqual([expect.objectContaining({ action: "regenerate", reason: "mais curto" })]);
    await t.app.reprepare(a.id);
    expect(t.store.get(a.id)!.status).toBe("pending_approval");
    expect(t.notifier.approvals).toHaveLength(3);
    expect(t.store.transitionsOf(a.id).map((x) => x.to)).toContain("ready");
  });

  it("reject records the reason; stale actions throw ILLEGAL_TRANSITION", async () => {
    const t = setup();
    const a = (await t.app.addManual("texto para ser rejeitado depois"))!.item!;
    await t.app.tick();
    await t.app.reject(a.id, "antigo");
    expect(t.store.get(a.id)!.status).toBe("rejected");
    expect(t.store.approvalsOf(a.id)[0]).toMatchObject({ action: "reject", reason: "antigo" });
    await expect(t.app.approve(a.id)).rejects.toBeInstanceOf(KitError);
  });

  it("gate holds generation: pending cap, daily cap, pause; urgent bypass", async () => {
    const t = setup({ profile: { pipeline: { maxPendingApproval: 1, dailyApprovalCap: 5 } } as never });
    const make = (k: string, score: number) => t.store.insertRaw({ dedupeKey: k, origin: "feed", source: "s", author: k, text: "texto " + k }, { status: "scored", score })!;
    make("a", 70);
    await t.app.tick();
    expect(t.store.count("pending_approval")).toBe(1);
    const b = make("b", 70);
    await t.app.tick();
    expect(t.store.get(b.id)!.status).toBe("scored");
    expect(t.app.status().gate).toMatch(/aguardando decisão/);
    const c = make("c", 95);
    await t.app.tick();
    expect(t.store.get(c.id)!.status).toBe("pending_approval");

    t.app.setPaused(true);
    expect(t.app.isPaused()).toBe(true);
    const r = await t.app.tick();
    expect(r.curate.curated).toBe(0);
    t.app.setPaused(false);
    expect(t.app.status().counts.scored).toBe(1);
  });

  it("subject cooldown holds a second item by the same author in ready", async () => {
    const t = setup({ profile: { pipeline: { subjectCooldownHours: 4, maxPendingApproval: 5 } } as never });
    const mk = (k: string) => t.store.insertRaw({ dedupeKey: k, origin: "feed", source: "s", author: "same", text: "t" + k }, { status: "scored", score: 70 })!;
    const a = mk("1");
    const b = mk("2");
    await t.app.tick();
    expect(t.store.get(a.id)!.status).toBe("pending_approval");
    expect(t.store.get(b.id)!.status).toBe("ready");
    t.clock.advanceMs(5 * 3600_000);
    await t.app.tick();
    expect(t.store.get(b.id)!.status).toBe("pending_approval");
  });

  it("scheduler runs jobs without overlap and logs job_runs", async () => {
    const t = setup();
    let running = 0;
    let max = 0;
    const job = async () => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return "ok";
    };
    const s = new Scheduler({ jobs: { a: job, b: job }, intervalsMinutes: { a: 1, b: 1 }, store: t.store, setInterval: () => 0, clearInterval: () => {} });
    s.start(true);
    s.enqueue("a");
    await s.stop();
    expect(max).toBe(1);
    expect(t.store.recentJobRuns().length).toBeGreaterThanOrEqual(2);
    expect(t.store.recentJobRuns()[0]!.ok).toBe(true);
  });
});

describe("approve: media selection, no-destination and daily cap", () => {
  const withMedia = (t: ReturnType<typeof setup>, id: string, prepared: object[]) => {
    t.store.setPrepared(id, prepared as never);
  };

  it("a platform variant replaces the generic video for that destination only", async () => {
    const t = setup({ profile: { destinations: [{ platform: "tiktok", publisher: "buffer", only: "video" }, { platform: "instagram", publisher: "buffer" }] } as never });
    const a = (await t.app.addManual("texto para testar variantes de plataforma"))!.item!;
    await t.app.runPipeline();
    withMedia(t, a.id, [
      { type: "video", localPath: "/x/generic.mp4", thirdParty: false },
      { type: "video", localPath: "/x/tiktok.mp4", thirdParty: false, platform: "tiktok" },
    ]);
    await t.app.approve(a.id);
    const byPlatform = Object.fromEntries(t.buffer.requests.map((r) => [r.destination.platform, r.media.map((m) => m.localPath)]));
    expect(byPlatform.tiktok).toEqual(["/x/tiktok.mp4"]);
    expect(byPlatform.instagram).toEqual(["/x/generic.mp4"]);
  });

  it("with no applicable destination the item stays approved with a manual outcome and a note", async () => {
    const t = setup({ media: "image", profile: { destinations: [{ platform: "tiktok", publisher: "buffer", only: "video" }] } as never });
    const a = (await t.app.addManual("texto sem destino que combine com a midia"))!.item!;
    await t.app.runPipeline();
    const out = await t.app.approve(a.id);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ platform: "tiktok", kind: "manual" });
    expect(out[0]!.error).toMatch(/nenhum destino/);
    expect(t.buffer.requests).toHaveLength(0);
    expect(t.store.get(a.id)!.status).toBe("approved");
    await t.app.markPublished(a.id, "tiktok");
    expect(t.store.get(a.id)!.status).toBe("published");
  });

  it("dailyCap: over the cap the Buffer destination falls back to manual", async () => {
    const t = setup({ profile: { destinations: [{ platform: "instagram", publisher: "buffer", dailyCap: 1 }] } as never });
    const a = (await t.app.addManual("primeiro texto do dia para o buffer"))!.item!;
    const b = (await t.app.addManual("segundo texto do dia para o buffer"))!.item!;
    await t.app.runPipeline();
    expect((await t.app.approve(a.id))[0]!.kind).toBe("buffer");
    const out = await t.app.approve(b.id);
    expect(out[0]).toMatchObject({ kind: "manual" });
    expect(out[0]!.error).toBe("limite diário de 1 atingido");
    expect(t.buffer.requests).toHaveLength(1);
    expect(t.store.get(b.id)!.status).toBe("approved");
  });

  it("addManual surfaces the source error instead of the generic message", async () => {
    const t = setup({ sources: [new FakeSource("br", [], { fromInput: () => { throw new Error("O Chrome dedicado não está aberto."); } })] });
    const r = await t.app.addManual("https://www.instagram.com/p/abc/");
    expect(r.error).toBe("O Chrome dedicado não está aberto.");
  });

  it("idle() waits for queued pipeline work", async () => {
    const t = setup();
    await t.app.addManual("texto para esperar o pipeline terminar");
    void t.app.runPipeline();
    await t.app.idle();
    expect(t.notifier.approvals).toHaveLength(1);
  });

  it("store.list can filter by origin in SQL", async () => {
    const t = setup();
    await t.app.addManual("um item manual qualquer para a lista");
    expect(t.store.list("new", 10, { origin: "feed" })).toHaveLength(0);
    expect(t.store.list("new", 10, { origin: "manual" })).toHaveLength(1);
  });
});
