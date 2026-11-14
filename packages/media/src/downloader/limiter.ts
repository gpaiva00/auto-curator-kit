import { DownloaderError } from "./errors.js";

export interface RateLimiterOptions {
  /** Minimum gap between the END of one call and the START of the next. */
  minDelayMs: number;
  /** Extra random delay in [0, jitterMs]. */
  jitterMs: number;
  /** Hard cap of calls in a rolling hour (counted at start). */
  maxPerHour: number;
  /** After a remote RATE_LIMITED, refuse all calls for this long. */
  cooldownMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Serial (concurrency 1) in-process limiter with jitter, hourly cap and a cooldown circuit breaker. */
export class RateLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private lastEnd = 0;
  private starts: number[] = [];
  private blockedUntil = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: RateLimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  /** Call when the remote side told us to slow down. */
  trip(): void {
    this.blockedUntil = this.now() + this.opts.cooldownMs;
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.assertOpen();
      if (this.lastEnd > 0) {
        const wait = this.lastEnd + this.opts.minDelayMs + this.random() * this.opts.jitterMs - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.assertOpen();
      const t = this.now();
      this.starts = this.starts.filter((s) => t - s < 3_600_000);
      if (this.starts.length >= this.opts.maxPerHour) {
        throw new DownloaderError("Limite local de requisicoes por hora atingido", "RATE_LIMITED");
      }
      this.starts.push(t);
      try {
        return await fn();
      } finally {
        this.lastEnd = this.now();
      }
    };
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => undefined);
    return p;
  }

  private assertOpen(): void {
    if (this.now() < this.blockedUntil) {
      throw new DownloaderError("Em pausa apos resposta de rate limit", "RATE_LIMITED");
    }
  }
}
