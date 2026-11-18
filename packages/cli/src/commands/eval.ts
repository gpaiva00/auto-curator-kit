import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errMsg, systemClock, type Draft, type Item, type Verdict } from "@auto-curator/contracts";
import { ConfigError, curateOne, matchBlocked, type JobDeps } from "@auto-curator/engine";
import type { CmdCtx } from "../io.js";
import { EvalFile, checkCase, type EvalCase, type EvalItem } from "../evalMatch.js";
import { brl } from "../format.js";
import { resolveProfile } from "../profile.js";
import { buildRuntime } from "../wire.js";
import { roleKeyEnvs } from "./doctor.js";

export function loadEvalFile(file: string): EvalCase[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`Casos de eval ilegíveis (${file}): ${errMsg(e)}`);
  }
  const r = EvalFile.safeParse(raw);
  if (!r.success) throw new ConfigError(`Casos de eval inválidos (${file}):\n${r.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return r.data;
}

/** Builds the in-memory Item the Curator would receive for an eval case. */
export function itemFromEval(e: EvalItem, now = new Date()): Item {
  const t = now.toISOString();
  return {
    id: e.id,
    dedupeHash: `eval:${e.id}`,
    origin: e.origin ?? "feed",
    source: e.source,
    sourceUrl: e.sourceUrl ?? null,
    author: e.author,
    title: e.title ?? null,
    text: e.text,
    media: e.media,
    postedAt: e.postedAt ?? null,
    capturedAt: t,
    engagement: e.engagement,
    extra: e.extra,
    status: "curated",
    score: null,
    reason: null,
    draft: null,
    prepared: [],
    telegramMsgIds: [],
    attempts: 0,
    priority: 0,
    createdAt: t,
    updatedAt: t,
  };
}

export interface EvalRow {
  group: string;
  name: string;
  pass: boolean;
  finalVerdict: Verdict | "error";
  modelVerdict: string;
  flags: string[];
  problems: string[];
}

export async function evalCommand(ctx: CmdCtx): Promise<number> {
  const dir = resolveProfile(ctx.args.profile, ctx.env, ctx.profilesRoot);
  const rt = buildRuntime(dir, ctx.env, { plugins: ctx.plugins });
  const o = ctx.io.out;
  try {
    const { bundle, store } = rt;
    const groups: { group: string; file: string }[] = [
      { group: "template", file: join(bundle.templateDir, "evals", "cases.json") },
      { group: "perfil", file: join(bundle.profileDir, "evals", "cases.json") },
    ];
    let cases: { group: string; c: EvalCase }[] = [];
    for (const g of groups) if (existsSync(g.file)) cases.push(...loadEvalFile(g.file).map((c) => ({ group: g.group, c })));
    if (ctx.args.case) {
      const q = ctx.args.case.toLowerCase();
      cases = cases.filter(({ c }) => c.name.toLowerCase() === q || c.name.toLowerCase().includes(q));
      if (!cases.length) {
        ctx.io.err(`Nenhum caso com o nome "${ctx.args.case}".`);
        return 1;
      }
    }
    if (!cases.length) {
      o("Nenhum caso de eval encontrado (templates/<template>/evals/cases.json ou profiles/<id>/evals/cases.json).");
      return 0;
    }

    const keys = roleKeyEnvs(bundle.models.roles.curator);
    if (!keys.some((k) => ctx.env[k]?.trim())) {
      ctx.io.err(`❌ Sem chave de API para o Curador. Defina uma destas no .env do perfil: ${keys.join(", ")}.`);
      return 1;
    }

    const jobDeps: JobDeps = {
      bundle, store, llm: rt.llm, prompts: rt.prompts, preparer: rt.preparer, veto: rt.veto,
      clock: systemClock, logger: rt.logger, env: ctx.env, isPaused: () => false,
    };
    o(`Rodando ${cases.length} caso(s) no modelo real (${bundle.models.roles.curator.model})...`);
    const before = store.monthSpendBRL();
    const rows: EvalRow[] = [];
    for (const { group, c } of cases) {
      const item = itemFromEval(c.item);
      let final: Verdict | "error";
      let modelVerdict = "-";
      let draft: Draft | undefined;
      let error: string | undefined;
      const blocked = matchBlocked(`${item.title ?? ""}\n${item.text}`, bundle.profile.editorial.blockedPatterns);
      if (blocked) {
        final = "skip";
        modelVerdict = "prefiltro";
      } else {
        try {
          draft = await curateOne(jobDeps, item);
          final = draft.verdict;
          modelVerdict = "ok";
        } catch (e) {
          final = "error";
          modelVerdict = "erro";
          error = errMsg(e);
        }
      }
      const problems = error ? [`erro: ${error}`] : checkCase(c.expect, final, draft);
      rows.push({ group, name: c.name, pass: problems.length === 0, finalVerdict: final, modelVerdict, flags: draft?.riskFlags ?? [], problems });
      o(`${problems.length ? "❌" : "✅"} ${c.name}`);
    }

    o();
    const w = Math.max(...rows.map((r) => r.name.length), 4);
    o(`${"Caso".padEnd(w)}  Resultado  Veredito      Flags`);
    for (const r of rows) o(`${r.name.padEnd(w)}  ${(r.pass ? "passou" : "FALHOU").padEnd(9)}  ${r.finalVerdict.padEnd(12)}  ${r.flags.join(",") || "-"}`);
    const failed = rows.filter((r) => !r.pass);
    for (const r of failed) o(`\n❌ ${r.name} [${r.group}]\n   ${r.problems.join("\n   ")}`);
    const cost = store.monthSpendBRL() - before;
    o();
    o(`${rows.length - failed.length}/${rows.length} passaram. Custo desta rodada: ${brl(cost, 4)} (gasto do mês: ${brl(store.monthSpendBRL())} de ${brl(bundle.models.monthlyBudgetBRL)}).`);
    return failed.length ? 1 : 0;
  } finally {
    rt.close();
  }
}
