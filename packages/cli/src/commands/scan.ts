import { RawItem as RawItemSchema, errMsg, systemClock, type RawItem, type Source } from "@auto-curator/contracts";
import { Store, ingest, matchBlocked, sha256, sourceContext, summarizeIngest, type JobDeps, type ProfileBundle } from "@auto-curator/engine";
import type { CmdCtx } from "../io.js";
import { resolveProfile } from "../profile.js";
import { buildRuntime } from "../wire.js";

const HOUR = 3_600_000;

/** Why the engine's ingest would drop an item before any LLM call (pt-BR), or undefined when it would be kept. Mirrors engine ingest. */
export function explainPrefilter(raw: RawItem, bundle: Pick<ProfileBundle, "profile">, store: Pick<Store, "hasHash">, now: number): string | undefined {
  const parsed = RawItemSchema.safeParse(raw);
  if (!parsed.success) return `item inválido (${parsed.error.issues[0]?.message})`;
  const r = parsed.data;
  if (store.hasHash(sha256(r.dedupeKey))) return "repetido (já está no banco)";
  if (r.origin === "manual") return undefined;
  const p = bundle.profile;
  const blocked = matchBlocked(`${r.title ?? ""}\n${r.text}`, p.editorial.blockedPatterns);
  if (blocked) return `padrão bloqueado (${blocked})`;
  const when = r.postedAt ? Date.parse(r.postedAt) : NaN;
  if (Number.isFinite(when) && (now - when) / HOUR > p.pipeline.maxItemAgeHours) return `antigo (mais de ${p.pipeline.maxItemAgeHours}h)`;
  return undefined;
}

const clip = (s: string, n: number) => (s.replace(/\s+/g, " ").trim().length <= n ? s.replace(/\s+/g, " ").trim() : `${s.replace(/\s+/g, " ").trim().slice(0, n - 1)}…`);

/** Runs every source once, without LLM. Prints what would be ingested and why the rest is filtered; unless --dry, ingests it. */
export async function scanCommand(ctx: CmdCtx): Promise<number> {
  const dir = resolveProfile(ctx.args.profile, ctx.env, ctx.profilesRoot);
  const rt = buildRuntime(dir, ctx.env, { plugins: ctx.plugins });
  const o = ctx.io.out;
  try {
    const { bundle, store } = rt;
    const jobDeps: JobDeps = {
      bundle, store, llm: rt.llm, prompts: rt.prompts, preparer: rt.preparer, veto: rt.veto,
      clock: systemClock, logger: rt.logger, env: ctx.env, isPaused: () => false,
    };
    o(`Lendo ${rt.sources.length} fonte(s) de "${bundle.profile.name}"${ctx.args.dry ? " (--dry: nada será gravado)" : ""}...`);
    o();

    const replay: Source[] = [];
    let failed = 0;
    for (const source of rt.sources) {
      let raws: RawItem[];
      try {
        raws = await source.fetch(sourceContext(jobDeps, source));
      } catch (e) {
        failed++;
        o(`❌ ${source.name} (${source.type}): ${errMsg(e)}`);
        continue;
      }
      const now = systemClock.now().getTime();
      let kept = 0;
      const lines: string[] = [];
      for (const raw of raws) {
        const why = explainPrefilter(raw, bundle, store, now);
        if (!why) kept++;
        const title = clip(raw.title || raw.text || "(sem título)", 90);
        lines.push(`   ${why ? "✗" : "•"} ${title}${raw.author ? ` — ${raw.author}` : ""}${raw.sourceUrl ? `\n     ${raw.sourceUrl}` : ""}${why ? `\n     filtrado: ${why}` : ""}`);
      }
      o(`${raws.length ? "✅" : "⚠️ "} ${source.name} (${source.type}): ${raws.length} item(ns), ${kept} passam no pré-filtro`);
      for (const l of lines) o(l);
      o();
      // the engine ingests exactly what we already fetched (browser sources must not be read twice)
      replay.push({ type: source.type, name: source.name, fetch: async () => raws });
    }

    if (ctx.args.dry) {
      o("--dry: nada foi gravado no banco.");
    } else {
      const result = await ingest(jobDeps, replay);
      o(summarizeIngest(result));
      o(`Banco: ${rt.store.count("new")} item(ns) novo(s) aguardando triagem/curadoria.`);
    }
    return failed > 0 && failed === rt.sources.length ? 1 : 0;
  } finally {
    rt.close();
  }
}
