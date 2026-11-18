import { describe, expect, it } from "vitest";
import { Draft, type DraftInput } from "@auto-curator/contracts";
import { okDraft } from "@auto-curator/engine/testing";
import { EvalCase, EvalFile, checkCase } from "../src/evalMatch.js";
import { itemFromEval } from "../src/commands/eval.js";

const draft = (over: Partial<DraftInput> = {}) => Draft.parse(okDraft(over));

describe("checkCase", () => {
  it("passes on the expected verdict and on alsoAcceptable", () => {
    expect(checkCase({ verdict: "publish" }, "publish", draft())).toEqual([]);
    expect(checkCase({ verdict: "needs_human", alsoAcceptable: ["skip"] }, "skip", draft({ verdict: "skip" }))).toEqual([]);
  });

  it("fails on a wrong verdict, naming what was accepted", () => {
    const p = checkCase({ verdict: "skip", alsoAcceptable: ["needs_human"] }, "publish", draft());
    expect(p).toEqual(["veredito publish, esperado skip ou needs_human"]);
  });

  it("checks required flags case-insensitively", () => {
    expect(checkCase({ verdict: "needs_human", mustFlag: ["Health"] }, "needs_human", draft({ riskFlags: ["health"] }))).toEqual([]);
    expect(checkCase({ verdict: "needs_human", mustFlag: ["health", "minor"] }, "needs_human", draft({ riskFlags: ["health"] }))).toEqual(["faltou a flag minor"]);
  });

  it("checks include / not-include on headline, credit and body", () => {
    const d = draft({ headline: "Leonardo lança single", sourceCredit: "Reprodução @leonardo via @portal", body: "Veja o clipe de @leonardo." });
    expect(
      checkCase(
        { verdict: "publish", headlineMustInclude: ["leonardo"], headlineMustNotInclude: ["Leo Dias"], sourceCreditMustInclude: ["@leonardo", "@portal"], bodyMustInclude: ["@LEONARDO"] },
        "publish",
        d,
      ),
    ).toEqual([]);
    const bad = checkCase(
      { verdict: "publish", headlineMustInclude: ["Rafa"], headlineMustNotInclude: ["Leonardo"], sourceCreditMustInclude: ["@x"], sourceCreditMustNotInclude: ["portal"], bodyMustInclude: ["zzz"], bodyMustNotInclude: ["clipe"] },
      "publish",
      d,
    );
    expect(bad).toEqual([`título sem "Rafa"`, `título contém "Leonardo"`, `crédito sem "@x"`, `crédito contém "portal"`, `texto sem "zzz"`, `texto contém "clipe"`]);
  });

  it("only checks the verdict when there is no draft (pre-filter skip or error)", () => {
    expect(checkCase({ verdict: "skip", mustFlag: ["x"], headlineMustInclude: ["y"] }, "skip", undefined)).toEqual([]);
    expect(checkCase({ verdict: "publish" }, "error", undefined)).toHaveLength(1);
  });
});

describe("eval case files", () => {
  it("accepts both `expect` and `expected`", () => {
    const base = { name: "a", item: { text: "x" } };
    const a = EvalCase.parse({ ...base, expect: { verdict: "skip" } });
    const b = EvalCase.parse({ ...base, expected: { verdict: "skip" }, note: "n" });
    expect(a.expect.verdict).toBe("skip");
    expect(b.note).toBe("n");
    expect(EvalFile.safeParse([{ ...base }]).success).toBe(false);
  });

  it("builds an Item with defaults from a case item", () => {
    const c = EvalCase.parse({ name: "a", expect: { verdict: "publish" }, item: { id: "c1", text: "oi", author: "ana", media: [{ type: "image", url: "https://x/y.jpg" }] } });
    const item = itemFromEval(c.item);
    expect(item).toMatchObject({ id: "c1", origin: "feed", status: "curated", author: "ana", draft: null, title: null });
    expect(item.media).toHaveLength(1);
  });
});
