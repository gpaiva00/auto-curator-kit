import { statusText } from "@auto-curator/telegram";
import type { CmdCtx } from "../io.js";
import { resolveProfile } from "../profile.js";
import { buildRuntime } from "../wire.js";

export async function statusCommand(ctx: CmdCtx): Promise<number> {
  const rt = buildRuntime(resolveProfile(ctx.args.profile, ctx.env, ctx.profilesRoot), ctx.env, { plugins: ctx.plugins });
  try {
    ctx.io.out(statusText(rt.app.status()));
    const runs = rt.store.recentJobRuns(5);
    if (runs.length) {
      ctx.io.out();
      ctx.io.out("Últimas execuções:");
      for (const r of runs) ctx.io.out(`• ${r.startedAt} ${r.job}: ${r.ok === null ? "em andamento" : r.ok ? "ok" : `falhou (${r.error ?? "?"})`}${r.summary ? ` — ${r.summary.slice(0, 120)}` : ""}`);
    }
    return 0;
  } finally {
    rt.close();
  }
}
