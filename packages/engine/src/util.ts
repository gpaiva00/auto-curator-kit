import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "@auto-curator/contracts";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

const safeJson = (v: unknown): string => {
  if (v instanceof Error) return v.message;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

/** Console logger with ISO timestamps. Level from the argument, else LOG_LEVEL, else "info". Writes no files. */
export function createLogger(level?: LogLevel, sink: (line: string) => void = (l) => console.log(l)): Logger {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  const min: number = LEVELS[level ?? (envLevel && envLevel in LEVELS ? (envLevel as LogLevel) : "info")];
  const emit =
    (l: LogLevel) =>
    (msg: string, ...a: unknown[]) => {
      if (LEVELS[l] < min) return;
      const tail = a.length ? " " + a.map(safeJson).join(" ") : "";
      sink(`${new Date().toISOString()} ${l.toUpperCase().padEnd(5)} ${msg}${tail}`);
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const newId = (prefix = "i_"): string => `${prefix}${randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** Local calendar day (YYYY-MM-DD) in a time zone. */
export function dayKey(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
/** Local month (YYYY-MM) in a time zone. */
export const monthKey = (d: Date, timeZone: string): string => dayKey(d, timeZone).slice(0, 7);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
