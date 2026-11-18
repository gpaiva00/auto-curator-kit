import { describe, expect, it } from "vitest";
import { KitError } from "@auto-curator/contracts";
import { Store } from "../src/index.js";
import { fixedClock, okDraft } from "../src/testing.js";
import { Draft } from "@auto-curator/contracts";

const raw = (k: string, extra = {}) => ({ dedupeKey: k, origin: "feed" as const, source: "s", author: "ana", text: "hello", ...extra });

describe("store", () => {
  it("inserts, dedupes by hash and maps the Item", () => {
    const s = new Store(":memory:");
    const a = s.insertRaw(raw("k1", { engagement: { likes: 3 } }))!;
    expect(a.status).toBe("new");
    expect(a.engagement.likes).toBe(3);
    expect(s.insertRaw(raw("k1"))).toBeUndefined();
    expect(s.count("new")).toBe(1);
  });

  it("walks legal transitions and logs them", () => {
    const s = new Store(":memory:");
    const a = s.insertRaw(raw("k"))!;
    s.transition(a.id, "scored", "x");
    s.transition(a.id, "curated");
    expect(s.transitionsOf(a.id).map((t) => t.to)).toEqual(["new", "scored", "curated"]);
  });

  it("rejects illegal transitions", () => {
    const s = new Store(":memory:");
    const a = s.insertRaw(raw("k"))!;
    try {
      s.transition(a.id, "published");
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(KitError);
      expect((e as KitError).code).toBe("ILLEGAL_TRANSITION");
    }
    s.transition(a.id, "skipped");
    expect(() => s.transition(a.id, "curated")).toThrow(/ilegal/i);
    expect(() => s.transition("nope", "curated")).toThrow(KitError);
  });

  it("stores drafts, kv, usage, publications and attempts", () => {
    const clock = fixedClock();
    const s = new Store({ path: ":memory:", clock });
    const a = s.insertRaw(raw("k"))!;
    s.setDraft(a.id, Draft.parse(okDraft()));
    expect(s.get(a.id)!.draft?.headline).toBe("Título de teste");
    s.kvSet("a", "1");
    expect(s.kvGet("a")).toBe("1");
    s.kvDel("a");
    expect(s.kvGet("a")).toBeUndefined();
    s.recordUsage({ role: "curator", model: "m", inputTokens: 1, outputTokens: 1, costBRL: 0.5, ok: true });
    expect(s.monthSpendBRL()).toBeCloseTo(0.5);
    expect(s.bumpAttempts(a.id)).toBe(1);
    const p = s.addPublication({ itemId: a.id, platform: "x", publisher: "manual", status: "manual" });
    s.updatePublication(p.id, { status: "published" });
    expect(s.listPublications({ status: ["published"] })).toHaveLength(1);
    s.recordApproval(a.id, "reject", "antigo");
    expect(s.approvalsOf(a.id)[0]!.reason).toBe("antigo");
  });

  it("expires old unfinished non-manual items and tracks last post by author", () => {
    const clock = fixedClock();
    const s = new Store({ path: ":memory:", clock });
    const a = s.insertRaw(raw("a"))!;
    const m = s.insertRaw({ ...raw("m"), origin: "manual" })!;
    clock.advanceMs(48 * 3600_000);
    expect(s.expireOld(clock.now().toISOString())).toBe(1);
    expect(s.get(a.id)!.status).toBe("skipped");
    expect(s.get(m.id)!.status).toBe("new");

    const b = s.insertRaw(raw("b"))!;
    for (const t of ["scored", "curated", "ready", "pending_approval"] as const) s.transition(b.id, t);
    expect(s.lastPostAboutAuthor("ANA")).toBeInstanceOf(Date);
    expect(s.lastPostAboutAuthor("ANA", b.id)).toBeUndefined();
    expect(s.presentedToday()).toBe(1);
  });

  it("applies migrations once", () => {
    const s = new Store(":memory:");
    expect((s.db.prepare("SELECT COUNT(*) n FROM _migrations").get() as { n: number }).n).toBe(1);
  });
});
