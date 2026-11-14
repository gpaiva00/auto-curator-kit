import { describe, expect, it } from "vitest";
import { Draft, type Item } from "@auto-curator/contracts";
import { Store, enforceEditorial, makeBundle, matchBlocked, okDraft, parseVeto, queueGate } from "../src/index.js";
import { tmp } from "./helpers.js";

const item = { id: "i", author: "ana", source: "S", title: null, text: "texto original" } as unknown as Item;
const draft = (o = {}) => Draft.parse(okDraft(o));
const run = (d: Draft, profile: Record<string, unknown> = {}, extra: string[] = [], veto?: ReturnType<typeof parseVeto>) => {
  const b = makeBundle(tmp(), profile as never, { draftExtraRequired: extra });
  return enforceEditorial(d, item, b.profile, b.template, { veto });
};

describe("enforceEditorial", () => {
  it("passes a clean draft", () => {
    const r = run(draft());
    expect(r.draft.verdict).toBe("publish");
    expect(r.notes).toEqual([]);
  });
  it("skip flags -> skip; forceReview and unknown flags -> needs_human", () => {
    const cfg = { editorial: { riskFlags: ["a", "b"], forceReview: ["b"], skip: ["z"] } };
    expect(run(draft({ riskFlags: ["z"] }), cfg).draft.verdict).toBe("skip");
    expect(run(draft({ riskFlags: ["b"] }), cfg).draft.verdict).toBe("needs_human");
    expect(run(draft({ riskFlags: ["a"] }), cfg).draft.verdict).toBe("publish");
    const unk = run(draft({ riskFlags: ["weird"] }), cfg);
    expect(unk.draft.verdict).toBe("needs_human");
    expect(unk.draft.riskFlags).toContain("weird");
  });
  it("never upgrades skip and low confidence needs a human", () => {
    expect(run(draft({ verdict: "skip", skipReason: "meh", confidence: 0.1 })).draft.verdict).toBe("skip");
    expect(run(draft({ confidence: 0.2 })).draft.verdict).toBe("needs_human");
  });
  it("clips headline/body and hashtags", () => {
    const r = run(draft({ headline: "h".repeat(150), body: "b".repeat(300), hashtags: ["#a", "#b", "#c", "#d"] }), { editorial: { headline: { maxChars: 20 }, body: { maxChars: 100 }, hashtags: { max: 2 } } });
    expect(r.draft.headline.length).toBe(20);
    expect(r.draft.body.length).toBe(100);
    expect(r.draft.hashtags).toEqual(["#a", "#b"]);
    expect(r.draft.verdict).toBe("publish");
  });
  it("too few hashtags -> needs_human", () => {
    expect(run(draft({ hashtags: ["#a"] }), { editorial: { hashtags: { min: 3 } } }).draft.verdict).toBe("needs_human");
  });
  it("credit=show without sourceCredit builds one and flags it", () => {
    const r = run(draft({ sourceCredit: undefined }), { editorial: { credit: "show" } });
    expect(r.draft.sourceCredit).toBe("Fonte: ana");
    expect(r.draft.verdict).toBe("needs_human");
    expect(run(draft({ sourceCredit: undefined }), { editorial: { credit: "hide" } }).draft.verdict).toBe("publish");
  });
  it("missing required extra keys -> needs_human; firstComment dropped when not allowed", () => {
    expect(run(draft(), {}, ["categoryTag"]).draft.verdict).toBe("needs_human");
    expect(run(draft({ extra: { categoryTag: "x" } }), {}, ["categoryTag"]).draft.verdict).toBe("publish");
    expect(run(draft({ firstComment: "oi" })).draft.firstComment).toBeUndefined();
    expect(run(draft({ firstComment: "oi" }), { editorial: { firstComment: true } }).draft.firstComment).toBe("oi");
  });
  it("veto: hard hit -> skip, soft hit -> needs_human, benign cancels", () => {
    const veto = parseVeto({ vetoFlags: ["morte"], reviewFlags: ["saude"], flags: { morte: { keywords: ["faleceu"], benign: ["ficcao"] }, saude: { keywords: ["câncer"] } } });
    const hard = run(draft({ body: "O ator FALECEU ontem, segundo a família." }), {}, [], veto);
    expect(hard.draft.verdict).toBe("skip");
    expect(hard.draft.riskFlags).toContain("morte");
    expect(run(draft({ body: "Ela venceu o cancer após anos de luta intensa." }), {}, [], veto).draft.verdict).toBe("needs_human");
    expect(run(draft({ body: "Na ficção, o herói faleceu no capítulo final." }), {}, [], veto).draft.verdict).toBe("publish");
    expect(run(draft({ riskFlags: ["morte"] }), {}, [], veto).draft.verdict).toBe("skip");
  });
});

describe("matchBlocked", () => {
  it("matches case-insensitively and ignores bad regex", () => {
    expect(matchBlocked("Compre AGORA", ["compre agora"])).toBe("compre agora");
    expect(matchBlocked("x", ["("])).toBeUndefined();
  });
});

describe("queueGate", () => {
  const b = makeBundle(tmp(), { pipeline: { maxPendingApproval: 2, dailyApprovalCap: 10, urgentBypassScore: 90 } });
  const add = (s: Store, k: string, to: string[]) => {
    const it = s.insertRaw({ dedupeKey: k, origin: "feed", source: "s", text: "t" })!;
    for (const t of to) s.transition(it.id, t as never);
  };
  const gate = (s: Store, o = {}) => queueGate({ store: s, profile: b.profile, models: b.models, paused: false, stage: "curate", ...o });

  it("opens, then holds on pending cap unless urgent or manual", () => {
    const s = new Store(":memory:");
    expect(gate(s)).toBeUndefined();
    add(s, "1", ["scored", "curated", "ready", "pending_approval"]);
    add(s, "2", ["scored", "curated"]);
    expect(gate(s)).toMatch(/aguardando decisão/);
    expect(gate(s, { score: 95 })).toBeUndefined();
    expect(gate(s, { manual: true })).toBeUndefined();
  });
  it("holds when paused, on daily cap and when budget is exhausted", () => {
    const s = new Store(":memory:");
    expect(gate(s, { paused: true })).toBe("pausado");
    const small = makeBundle(tmp(), { pipeline: { dailyApprovalCap: 1, maxPendingApproval: 5 } });
    add(s, "1", ["scored", "curated", "ready", "pending_approval", "approved"]);
    expect(queueGate({ store: s, profile: small.profile, models: small.models, paused: false, stage: "present" })).toMatch(/limite diário/);
    s.recordUsage({ role: "curator", model: "m", inputTokens: 0, outputTokens: 0, costBRL: 60, ok: true });
    expect(gate(s, { manual: true })).toMatch(/orçamento/);
  });
});
