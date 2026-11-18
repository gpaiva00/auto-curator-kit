import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaConfig, errMsg, silentLogger, type Draft, type DraftInput, type JsonRequest, type RawItem, type Status } from "@auto-curator/contracts";
import { App, FilePromptProvider, StaticPromptProvider, Store, loadProfile, loadVeto, type ProfileBundle } from "@auto-curator/engine";
import { FakeLlm, FakePublisher, FakeSource, RecordingNotifier, makeBundle } from "@auto-curator/engine/testing";
import { createPreparer } from "@auto-curator/media";
import { approvalText } from "@auto-curator/telegram";
import type { CmdCtx, Io } from "../io.js";
import { resolveProfile } from "../profile.js";
import { uiConfig } from "../wire.js";

/** A draft that satisfies the profile's editorial limits, so the policy does not downgrade it. */
export function fakeDraft(bundle: ProfileBundle, item: { title?: string | null; text?: string; author?: string; sourceUrl?: string | null }): DraftInput {
  const e = bundle.profile.editorial;
  const title = (item.title || item.text || "Item de teste").trim();
  const nHash = Math.min(e.hashtags.max, Math.max(e.hashtags.min, 3));
  const body = `${title}. Texto de demonstração gerado pelo dry-run, longo o bastante para passar nos limites do perfil e mostrar como o post fica na aprovação.`;
  const extra: Record<string, unknown> = { mediaPlan: { primaryMediaIndex: 0, useSubjectPhoto: false }, urgency: "media" };
  for (const k of bundle.template.draftExtraRequired) extra[k] = "DRY-RUN!";
  return {
    verdict: "publish",
    headline: title.slice(0, Math.min(e.headline.maxChars, 90)),
    body: body.slice(0, e.body.maxChars),
    hashtags: ["#dryrun", "#teste", "#curador", "#demo", "#exemplo", "#smoke"].slice(0, nHash),
    sourceCredit: e.credit === "show" ? `Fonte: ${item.author || "Fonte de teste"}` : undefined,
    firstComment: e.firstComment ? "Comentário de teste." : undefined,
    facts: item.sourceUrl ? [{ claim: title, sourceUrl: item.sourceUrl }] : [],
    riskFlags: [],
    confidence: 0.9,
    notes: "",
    extra,
  };
}

const arrow = (from: Status | null, to: Status) => `${from ?? "∅"} → ${to}`;

export interface DryRunResult {
  ok: boolean;
  problems: string[];
}

/**
 * Whole pipeline with fakes in a temp dir, no network: ingest (3 items) -> triage -> curate -> prepare (real preparer, strategy none)
 * -> approval card -> approve / reject. Returns ok=false when an expected step did not happen.
 */
export async function runDryRun(profileDir: string | undefined, env: NodeJS.ProcessEnv, io: Io): Promise<DryRunResult> {
  const o = io.out;
  const tmp = mkdtempSync(join(tmpdir(), "curador-dryrun-"));
  const problems: string[] = [];
  const scratchEnv = { ...env }; // loadProfile reads the profile's .env into the env it is given: keep the real one clean
  let store: Store | undefined;
  try {
    let bundle: ProfileBundle;
    if (profileDir) {
      const real = loadProfile(profileDir, scratchEnv);
      bundle = { ...real, dataDir: tmp };
      o(`Perfil: ${real.profile.name} (${real.profile.id}), template ${real.template.name}. Dados temporários em ${tmp}.`);
    } else {
      bundle = makeBundle(tmp, { id: "dry-run", name: "Perfil de Teste" });
      o(`Sem --profile: usando um perfil sintético. Dados temporários em ${tmp}.`);
    }
    o("Sem rede: LLM, fonte e Buffer são falsos; o preparo de mídia é o real, com strategy none.");
    o();

    mkdirSync(tmp, { recursive: true });
    store = new Store({ path: join(tmp, "curator.db"), timezone: bundle.profile.timezone });

    const now = new Date().toISOString();
    const raws: RawItem[] = [
      { dedupeKey: "dry:1", origin: "feed", source: "fake", author: "Agência Teste", title: "Descoberta importante anunciada hoje por pesquisadores", text: "Pesquisadores anunciaram uma descoberta importante, com dados publicados e fonte verificável.", sourceUrl: "https://example.com/noticia-1", postedAt: now, engagement: { likes: 900 } },
      { dedupeKey: "dry:2", origin: "feed", source: "fake", author: "Portal Exemplo", title: "Segundo assunto relevante do dia", text: "Um segundo assunto relevante, também com fonte clara e texto suficiente para a triagem.", sourceUrl: "https://example.com/noticia-2", postedAt: now, engagement: { likes: 400 } },
      { dedupeKey: "dry:3", origin: "feed", source: "fake", author: "Blog Qualquer", title: "Assunto irrelevante para o perfil", text: "Texto que a triagem falsa vai dar nota baixa, para mostrar um item descartado.", sourceUrl: "https://example.com/noticia-3", postedAt: now, engagement: { likes: 10 } },
    ];

    const llm = new FakeLlm({
      triage: (req: JsonRequest<unknown>) => {
        const payload = JSON.parse(req.user) as { items: { id: string; title?: string | null }[] };
        return payload.items.map((i) => (i.title?.includes("irrelevante") ? { id: i.id, score: 30, reason: "fora do assunto do perfil" } : { id: i.id, score: 85, reason: "relevante" }));
      },
      curator: (req: JsonRequest<unknown>) => {
        const payload = JSON.parse(req.user) as { item: { title: string | null; text: string; author: string; sourceUrl: string | null } };
        return fakeDraft(bundle, payload.item);
      },
    });
    const notifier = new RecordingNotifier();
    const publisher = new FakePublisher("buffer");
    const veto = loadVeto(bundle.profileDir, bundle.profile.editorial, silentLogger);
    let prompts: StaticPromptProvider | FilePromptProvider = new StaticPromptProvider();
    if (profileDir) {
      const fp = new FilePromptProvider({ profileDir: bundle.profileDir, templateDir: bundle.templateDir, profile: bundle.profile, draftExtraRequired: bundle.template.draftExtraRequired });
      try {
        fp.get("triage");
        fp.get("curator");
        prompts = fp;
        o("✅ Prompts do perfil carregados (triage, curator).");
      } catch (e) {
        problems.push(`prompts: ${errMsg(e)}`);
        o(`❌ Prompts: ${errMsg(e)}`);
      }
    }
    const app = new App({
      bundle, store, llm, prompts, veto,
      sources: [new FakeSource("fake", raws)],
      preparer: createPreparer({ media: MediaConfig.parse({ strategy: "none" }) }, { logger: silentLogger }),
      publishers: { buffer: publisher },
      notifier,
      logger: silentLogger,
      env: {},
    });

    const seen = new Map<string, number>();
    const flush = () => {
      for (const it of store!.list(["new", "scored", "curated", "ready", "pending_approval", "approved", "rejected", "published", "skipped"], 50).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
        const ts = store!.transitionsOf(it.id);
        for (const t of ts.slice(seen.get(it.id) ?? 0)) o(`   ${it.id}  ${arrow(t.from, t.to)}${t.note ? `  (${t.note})` : ""}`);
        seen.set(it.id, ts.length);
      }
    };

    o("1. Ingestão");
    o(`   ${await app.ingestNow()}`);
    flush();
    o("2. Triagem, curadoria, preparo e envio para aprovação");
    const tick = await app.tick();
    o(`   triagem: ${tick.triage.scored} aprovados, ${tick.triage.skipped} descartados | curadoria: ${tick.curate.curated} curados | mídia: ${tick.prepare.prepared} | enviados: ${tick.present.presented}`);
    flush();

    const pending = store.list("pending_approval");
    if (pending.length < 2) problems.push(`esperava 2 itens em pending_approval, achei ${pending.length}`);
    o();
    o(`3. Cartões de aprovação (${notifier.approvals.length}), como o Telegram mostra:`);
    for (const item of notifier.approvals) {
      o("   ┌──────────────────────────────────────────");
      for (const l of approvalText(item, uiConfig(bundle)).split("\n")) o(`   │ ${l}`);
      o("   └──────────────────────────────────────────");
    }

    if (pending[0]) {
      o();
      o(`4. Aprovando ${pending[0].id}`);
      const outcomes = await app.approve(pending[0].id);
      for (const oc of outcomes) {
        o(`   destino ${oc.platform}: ${oc.kind}${oc.mode ? ` (${oc.mode})` : ""}`);
        if (oc.kind !== "buffer") await app.markPublished(pending[0].id, oc.platform);
      }
      flush();
      const st = store.get(pending[0].id)!.status;
      if (st !== "published" && st !== "approved") problems.push(`item aprovado ficou em ${st}`);
      else if (outcomes.length === 0) problems.push("aprovação sem nenhum destino");
    }
    if (pending[1]) {
      o(`5. Rejeitando ${pending[1].id} (motivo: sem_valor)`);
      await app.reject(pending[1].id, "sem_valor");
      flush();
    }

    const s = app.status();
    o();
    o(`Estado final: ${Object.entries(s.counts).map(([k, v]) => `${k}=${v}`).join(", ")} | gasto simulado R$ ${s.spendBRL.toFixed(2)} | publicações no Buffer falso: ${publisher.requests.length}`);
    if (!store.list(["published", "approved"]).length) problems.push("nenhum item chegou a aprovado/publicado");
    if (store.count("skipped") < 1) problems.push("a triagem deveria ter descartado o item irrelevante");
  } catch (e) {
    problems.push(`erro inesperado: ${errMsg(e)}`);
  } finally {
    store?.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  o();
  o(problems.length ? `❌ dry-run falhou:\n${problems.map((p) => `   - ${p}`).join("\n")}` : "✅ dry-run completo: item chegou a pending_approval, foi aprovado, outro rejeitado e um descartado na triagem.");
  return { ok: problems.length === 0, problems };
}

export async function dryRunCommand(ctx: CmdCtx): Promise<number> {
  const wanted = ctx.args.profile ?? ctx.env.CURADOR_PROFILE;
  const dir = wanted ? resolveProfile(wanted, ctx.env, ctx.profilesRoot) : undefined;
  return (await runDryRun(dir, ctx.env, ctx.io)).ok ? 0 : 1;
}
