import { errMsg, silentLogger, type Logger } from "@auto-curator/contracts";
import type { Store } from "./store.js";

export type JobFn = () => Promise<unknown>;

export interface SchedulerDeps {
  /** job name -> function. */
  jobs: Record<string, JobFn>;
  /** job name -> interval in minutes (jobs without an interval are not scheduled). */
  intervalsMinutes: Record<string, number | undefined>;
  store?: Pick<Store, "startJobRun" | "finishJobRun">;
  isPaused?: () => boolean;
  logger?: Logger;
  /** injectable for tests */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

/** In-process timers. Runs are serialized (never overlap) and a job already queued is not queued twice. */
export class Scheduler {
  private handles: unknown[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private queued = new Set<string>();
  private stopped = false;
  private readonly log: Logger;

  constructor(private readonly d: SchedulerDeps) {
    this.log = d.logger ?? silentLogger;
  }

  start(runNow = true): void {
    this.stopped = false;
    const si = this.d.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    for (const [job, min] of Object.entries(this.d.intervalsMinutes)) {
      if (!min || !this.d.jobs[job]) continue;
      this.handles.push(si(() => void this.enqueue(job), min * 60_000));
    }
    if (runNow) for (const job of Object.keys(this.d.jobs)) if (this.d.intervalsMinutes[job]) void this.enqueue(job);
  }

  enqueue(job: string): Promise<void> {
    if (this.stopped || this.queued.has(job)) return this.chain.then(() => undefined);
    this.queued.add(job);
    const p = this.chain.then(async () => {
      this.queued.delete(job);
      if (this.d.isPaused?.()) {
        this.log.info(`agendador: pausado, pulando ${job}`);
        return;
      }
      const fn = this.d.jobs[job];
      if (!fn) return;
      const runId = this.d.store?.startJobRun(job);
      try {
        const r = await fn();
        if (runId !== undefined) this.d.store!.finishJobRun(runId, { ok: true, summary: typeof r === "string" ? r : undefined });
      } catch (e) {
        this.log.error(`job ${job} falhou: ${errMsg(e)}`);
        if (runId !== undefined) this.d.store!.finishJobRun(runId, { ok: false, error: errMsg(e) });
      }
    });
    this.chain = p;
    return p;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const ci = this.d.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));
    for (const h of this.handles) ci(h);
    this.handles = [];
    await this.chain;
  }
}

/** Wires the standard jobs of an App: ingest (reads sources) and pipeline (tick). */
export function createScheduler(app: { ingestNow(): Promise<string>; tick(): Promise<unknown>; isPaused(): boolean; store: Store; bundle: { profile: { pipeline: { intervalsMinutes: { ingest: number; pipeline: number } } } } }, logger?: Logger): Scheduler {
  const iv = app.bundle.profile.pipeline.intervalsMinutes;
  return new Scheduler({
    jobs: { ingest: () => app.ingestNow(), pipeline: async () => JSON.stringify(await app.tick()) },
    intervalsMinutes: { ingest: iv.ingest, pipeline: iv.pipeline },
    store: app.store,
    isPaused: () => app.isPaused(),
    logger,
  });
}
