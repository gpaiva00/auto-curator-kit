import { describe, expect, it } from "vitest";
import { inWindow, nextSlot } from "../src/slots.js";

// 2026-11-14 is in São Paulo (UTC-3): 15:00Z = 12:00 local.
const TZ = "America/Sao_Paulo";
const at = (iso: string) => new Date(iso);

describe("inWindow", () => {
  it("no window = always open", () => {
    expect(inWindow(at("2026-11-14T03:00:00Z"), {}, TZ)).toBe(true);
  });

  it("checks local hours in the profile timezone", () => {
    const w = { window: { start: "08:00", end: "22:00" } };
    expect(inWindow(at("2026-11-14T11:00:00Z"), w, TZ)).toBe(true); // 08:00 local
    expect(inWindow(at("2026-11-14T10:59:00Z"), w, TZ)).toBe(false); // 07:59 local
    expect(inWindow(at("2026-11-15T00:59:00Z"), w, TZ)).toBe(true); // 21:59 local
    expect(inWindow(at("2026-11-15T01:00:00Z"), w, TZ)).toBe(false); // 22:00 local, end is exclusive
  });

  it("wraps midnight", () => {
    const w = { window: { start: "22:00", end: "02:00" } };
    expect(inWindow(at("2026-11-15T01:30:00Z"), w, TZ)).toBe(true); // 22:30 local
    expect(inWindow(at("2026-11-15T04:30:00Z"), w, TZ)).toBe(true); // 01:30 local
    expect(inWindow(at("2026-11-15T05:30:00Z"), w, TZ)).toBe(false); // 02:30 local
  });
});

describe("nextSlot", () => {
  const now = at("2026-11-14T15:00:00Z"); // 12:00 local

  it("is now when there is no gap and no window", () => {
    expect(nextSlot(now, {}, undefined, TZ).getTime()).toBe(now.getTime());
  });

  it("respects the minimum gap after the last post", () => {
    const last = at("2026-11-14T14:30:00Z");
    expect(nextSlot(now, { minIntervalMinutes: 60 }, last, TZ).toISOString()).toBe("2026-11-14T15:30:00.000Z");
  });

  it("moves to the next window start when outside it", () => {
    const w = { window: { start: "08:00", end: "09:00" } };
    const late = at("2026-11-15T01:30:00Z"); // 22:30 local, closed
    expect(nextSlot(late, w, undefined, TZ).toISOString()).toBe("2026-11-15T11:00:00.000Z"); // 08:00 next day
  });

  it("combines gap and window", () => {
    const w = { window: { start: "08:00", end: "22:00" } };
    const last = at("2026-11-15T00:50:00Z"); // 21:50 local
    expect(nextSlot(now, { ...w, minIntervalMinutes: 60 }, last, TZ).toISOString()).toBe("2026-11-15T11:00:00.000Z");
  });
});
