import { describe, expect, it } from "vitest";
import { approvalKeyboard, cb, manualKeyboard, parseCallback, reasonsKeyboard } from "../src/index.js";
import { dest, ui } from "./helpers.js";

const bytes = (rows: { callback_data?: string }[][]) => rows.flat().map((b) => Buffer.byteLength(b.callback_data ?? ""));

describe("keyboards", () => {
  it("approval layout", () => {
    const k = approvalKeyboard("p_ab12");
    expect(k.map((r) => r.map((b) => b.callback_data))).toEqual([["a|p_ab12", "r|p_ab12"], ["eb|p_ab12", "eh|p_ab12"], ["rg|p_ab12"]]);
    expect(k[0]![0]!.text).toBe("✅ Aprovar");
  });

  it("needs_human: sem Aprovar, 🔁 Refazer, editar e rejeitar continuam", () => {
    const k = approvalKeyboard("p_ab12", false);
    expect(k.map((r) => r.map((b) => b.callback_data))).toEqual([["r|p_ab12"], ["eb|p_ab12", "eh|p_ab12"], ["rg|p_ab12"]]);
  });

  it("reasons two per row with back", () => {
    const k = reasonsKeyboard("p_ab12", ui().rejectReasons);
    expect(k[0]).toHaveLength(2);
    expect(k.at(-1)![0]!.callback_data).toBe("b|p_ab12");
    expect(k[0]![0]!.callback_data).toBe("rj|p_ab12|sem_contexto");
  });

  it("callback data stays within 64 bytes for long ids and codes", () => {
    const id = "p_" + "a".repeat(30);
    const reasons = [{ code: "x".repeat(20), label: "L" }];
    for (const rows of [approvalKeyboard(id), reasonsKeyboard(id, reasons), manualKeyboard(id, ["instagram", "linkedin"], [])]) expect(Math.max(...bytes(rows))).toBeLessThanOrEqual(64);
    expect(() => cb("a", "z".repeat(80))).toThrow();
  });

  it("manual keyboard: url button only with composeUrl", () => {
    const k = manualKeyboard("p1", ["linkedin", "tiktok"], [dest("linkedin", { composeUrl: "https://www.linkedin.com/feed/" }), dest("tiktok")]);
    expect(k[0]).toEqual([
      { text: "✍️ Abrir LinkedIn", url: "https://www.linkedin.com/feed/" },
      { text: "✅ Publiquei no LinkedIn", callback_data: "p|p1|linkedin" },
    ]);
    expect(k[1]).toEqual([{ text: "✅ Publiquei no TikTok", callback_data: "p|p1|tiktok" }]);
  });

  it("parseCallback", () => {
    expect(parseCallback("rj|p1|sem_valor")).toEqual({ act: "rj", id: "p1", arg: "sem_valor" });
    expect(parseCallback("a|p1")).toEqual({ act: "a", id: "p1", arg: undefined });
    expect(parseCallback("junk")).toBeUndefined();
  });
});
