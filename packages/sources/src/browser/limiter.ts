import { BrowserError } from "./errors.js";

export interface KeyValue {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface LimiterOptions {
  /** Minimum gap between the END of one read and the START of the next. */
  minDelaySeconds: number;
  /** Hard cap of reads in a rolling hour (counted at start). */
  maxPerHour: number;
  /** After the site asks us to slow down (`trip`), refuse every read for this long. */
  cooldownMinutes: number;
  /** Extra random delay in [0, jitterSeconds]. */
  jitterSeconds?: number;
  /** Persists the state (SourceContext.state), so the limits survive restarts and separate scans. */
  store?: KeyValue;
  /** Key under which the state is saved. */
  key?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface State {
  starts: number[];
  lastEnd: number;
  blockedUntil: number;
}

/**
 * Serial (concurrency 1) limiter for browser reads: minimum gap with jitter, hourly cap and a cooldown circuit breaker.
 * State is loaded before every read and saved after it, so a new instance per scan sees what the last one did.
 */
export class RateLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private mem: State = { starts: [], lastEnd: 0, blockedUntil: 0 };
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly key: string;

  constructor(private readonly o: LimiterOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = o.random ?? Math.random;
    this.key = o.key ?? "browser.limiter";
  }

  private load(): State {
    if (!this.o.store) return this.mem;
    try {
      const raw = this.o.store.get(this.key);
      if (raw) {
        const p = JSON.parse(raw) as Partial<State>;
        this.mem = { starts: Array.isArray(p.starts) ? p.starts.filter((n) => typeof n === "number") : [], lastEnd: Number(p.lastEnd) || 0, blockedUntil: Number(p.blockedUntil) || 0 };
      }
    } catch {
      /* corrupted state: keep what we have in memory */
    }
    return this.mem;
  }
  private save(): void {
    this.o.store?.set(this.key, JSON.stringify(this.mem));
  }

  /** Call when the site told us to slow down (challenge, "try again later"). */
  trip(): void {
    this.load();
    this.mem.blockedUntil = this.now() + this.o.cooldownMinutes * 60_000;
    this.save();
  }

  /** Minutes left of the cooldown (0 = open). */
  cooldownLeftMinutes(): number {
    return Math.max(0, Math.ceil((this.load().blockedUntil - this.now()) / 60_000));
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.assertOpen();
      const s = this.load();
      if (s.lastEnd > 0) {
        const wait = s.lastEnd + this.o.minDelaySeconds * 1000 + this.random() * (this.o.jitterSeconds ?? 0) * 1000 - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.assertOpen();
      const t = this.now();
      const cur = this.load();
      cur.starts = cur.starts.filter((x) => t - x < 3_600_000);
      if (cur.starts.length >= this.o.maxPerHour) {
        throw new BrowserError(`Limite local de ${this.o.maxPerHour} leituras por hora atingido; tente de novo mais tarde.`, "RATE_LIMITED");
      }
      cur.starts.push(t);
      this.save();
      try {
        return await fn();
      } finally {
        this.load();
        this.mem.lastEnd = this.now();
        this.save();
      }
    };
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => undefined);
    return p;
  }

  private assertOpen(): void {
    const left = Math.ceil((this.load().blockedUntil - this.now()) / 60_000);
    if (left > 0) throw new BrowserError(`Pausa de segurança ativa por mais ${left} min (a rede pediu para reduzir o ritmo).`, "RATE_LIMITED");
  }
}
