import { errMsg } from "@auto-curator/contracts";
import { createScheduler } from "@auto-curator/engine";
import type { CmdCtx } from "../io.js";
import { AlreadyRunningError, EXIT_ALREADY_RUNNING, acquireLock } from "../lock.js";
import { resolveProfile } from "../profile.js";
import { buildRuntime } from "../wire.js";

export interface StartOptions {
  /** Where SIGINT/SIGTERM are listened to (tests inject an EventEmitter). */
  signals?: Pick<NodeJS.Process, "once" | "off">;
  /** Resolves when the process should stop (tests). */
  stopWhen?: Promise<void>;
}

/** Starts bot + scheduler and resolves (exit code) after a graceful shutdown. */
export async function startCommand(ctx: CmdCtx, opts: StartOptions = {}): Promise<number> {
  const dir = resolveProfile(ctx.args.profile, ctx.env, ctx.profilesRoot);
  const rt = buildRuntime(dir, ctx.env, { withTelegram: true, plugins: ctx.plugins });
  const o = ctx.io.out;
  const bot = rt.bot!;
  let release: () => void;
  try {
    release = acquireLock(rt.bundle.dataDir);
  } catch (e) {
    rt.close();
    if (e instanceof AlreadyRunningError) {
      ctx.io.err(`❌ ${e.message}`);
      return EXIT_ALREADY_RUNNING;
    }
    throw e;
  }

  const { profile } = rt.bundle;
  const wantsBuffer = profile.destinations.some((d) => d.publisher === "buffer");
  if (wantsBuffer && !rt.publishers.buffer) rt.logger.warn("BUFFER_API_KEY ausente: destinos com Buffer vão cair no fluxo manual ao aprovar.");

  const scheduler = createScheduler(rt.app, rt.logger);
  o(`▶ "${profile.name}" (${profile.id}) iniciado. Dados em ${rt.bundle.dataDir}. Ingestão a cada ${profile.pipeline.intervalsMinutes.ingest} min, pipeline a cada ${profile.pipeline.intervalsMinutes.pipeline} min.`);
  o("  Ctrl+C para parar.");

  const signals = opts.signals ?? process;
  let stopping = false;
  const done = new Promise<number>((resolve) => {
    const stop = async (why: string, exitCode = 0) => {
      if (stopping) return;
      stopping = true;
      o(`\n⏹ ${why}: encerrando...`);
      let code = exitCode;
      try {
        await bot.stop(); // also waits for actions the bot started in the background
        await scheduler.stop();
        await rt.app.idle(); // nothing may touch the database after it is closed
      } catch (e) {
        ctx.io.err(`Erro ao encerrar: ${errMsg(e)}`);
        code = 1;
      } finally {
        rt.close();
        release();
      }
      resolve(code);
    };
    signals.once("SIGINT", () => void stop("SIGINT"));
    signals.once("SIGTERM", () => void stop("SIGTERM"));
    void opts.stopWhen?.then(() => stop("stop"));
    void bot.failed.then((err) => {
      ctx.io.err(`❌ ${err.message}`);
      void stop("erro fatal do Telegram", 1);
    });
  });

  try {
    await bot.start();
    scheduler.start(true);
  } catch (e) {
    ctx.io.err(`❌ Falha ao iniciar: ${errMsg(e)}`);
    await bot.stop().catch(() => undefined);
    await scheduler.stop();
    rt.close();
    release();
    return 1;
  }
  return done;
}
