import type { Destination } from "@auto-curator/contracts";

const STEP_MS = 5 * 60_000;
const MAX_SEARCH_DAYS = 8;

/** Minutes since local midnight in `tz`. */
function localMinutes(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/** True when `d` falls inside the destination's posting window (no window = always). Windows may wrap midnight (22:00-02:00). */
export function inWindow(d: Date, dest: Pick<Destination, "window">, tz: string): boolean {
  if (!dest.window) return true;
  const s = toMin(dest.window.start);
  const e = toMin(dest.window.end);
  const m = localMinutes(d, tz);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

/**
 * Earliest moment >= now that respects the channel's minimum gap after `last` and its posting window.
 * Walks in 5-minute steps (at most ~8 days), which keeps the rule obvious and timezone-safe.
 */
export function nextSlot(now: Date, dest: Pick<Destination, "minIntervalMinutes" | "window">, last: Date | undefined, tz: string): Date {
  const gap = (dest.minIntervalMinutes ?? 0) * 60_000;
  let t = Math.max(now.getTime(), last ? last.getTime() + gap : 0);
  const limit = t + MAX_SEARCH_DAYS * 24 * 60 * 60_000;
  while (t < limit) {
    if (inWindow(new Date(t), dest, tz)) return new Date(t);
    t += STEP_MS;
  }
  throw new Error(`janela de horário nunca abre nos próximos ${MAX_SEARCH_DAYS} dias`);
}
