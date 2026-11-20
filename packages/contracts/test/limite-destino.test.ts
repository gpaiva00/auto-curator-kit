import { describe, expect, it } from "vitest";
import { Destination, charCount, destinationMaxChars } from "../src/index.js";

describe("maxChars por destino", () => {
  it("sem o campo: só Threads por Buffer tem padrão (500); os outros não têm limite", () => {
    expect(destinationMaxChars({ platform: "threads", publisher: "buffer" })).toBe(500);
    expect(destinationMaxChars({ platform: "threads", publisher: "manual" })).toBeUndefined();
    expect(destinationMaxChars({ platform: "linkedin", publisher: "buffer" })).toBeUndefined();
  });

  it("com o campo, ele vence o padrão de compatibilidade", () => {
    expect(destinationMaxChars({ platform: "threads", publisher: "buffer", maxChars: 300 })).toBe(300);
    expect(destinationMaxChars({ platform: "linkedin", publisher: "buffer", maxChars: 3000 })).toBe(3000);
  });

  it("o schema aceita inteiro positivo e recusa zero, negativo e fracionário", () => {
    const base = { platform: "x", publisher: "manual" };
    expect(Destination.parse({ ...base, maxChars: 280 }).maxChars).toBe(280);
    expect(Destination.safeParse({ ...base, maxChars: 0 }).success).toBe(false);
    expect(Destination.safeParse({ ...base, maxChars: -1 }).success).toBe(false);
    expect(Destination.safeParse({ ...base, maxChars: 1.5 }).success).toBe(false);
  });

  it("conta pontos de código: emoji e acento contam 1", () => {
    expect(charCount("a")).toBe(1);
    expect(charCount("😀")).toBe(1);
    expect(charCount("ção")).toBe(3);
  });
});
