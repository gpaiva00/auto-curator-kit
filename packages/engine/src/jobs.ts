import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  Draft,
  RawItem,
  TriageEntry,
  errMsg,
  type Clock,
  type Item,
  type LlmPort,
  type Logger,
  type Notifier,
  type Preparer,
  type PromptProvider,
  type Source,
  type SourceContext,
} from "@auto-curator/contracts";
import type { ProfileBundle } from "./config.js";
import { BudgetExceededError, LlmOutputError, unwrapArray } from "./llm.js";
import { budgetGate, enforceEditorial, matchBlocked, queueGate, withNotes, type VetoRules } from "./policy.js";
import type { Store } from "./store.js";
import { sha256 as sha } from "./util.js";

export interface JobDeps {
  bundle: ProfileBundle;
  store: Store;
  llm: LlmPort;
  prompts: PromptProvider;
  preparer: Preparer;
  notifier?: Notifier;
  veto?: VetoRules;
  clock: Clock;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  isPaused: () => boolean;
}

const HOUR = 3_600_000;
const engagementOf = (i: { engagement: { likes?: number; comments?: number; shares?: number } }) => (i.engagement.likes ?? 0) + 2 * (i.engagement.comments ?? 0) + 3 * (i.engagement.shares ?? 0);

// ------------------------------------------------------------------ ingest

export interface SourceReport {
  source: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  filtered: number;
  error?: string;
}
export interface IngestResult {
  reports: SourceReport[];
  inserted: number;
}

export function sourceContext(d: JobDeps, source: Pick<Source, "name">): SourceContext {
  const key = (k: string) => `src:${source.name}:${k}`;
  return {
    now: d.clock.now(),
    profile: d.bundle.profile,
    dataDir: d.bundle.dataDir,
    env: d.env,
    logger: d.logger,
    state: { get: (k) => d.store.kvGet(key(k)), set: (k, v) => d.store.kvSet(key(k), v) },
  };
}

/** Fetches every source (failures isolated), prefilters without LLM, keeps the best `maxNewPerSource` by engagement. */
export async function ingest(d: JobDeps, sources: Source[]): Promise<IngestResult> {
  const p = d.bundle.profile;
  const out: IngestResult = { reports: [], inserted: 0 };
  const now = d.clock.now().getTime();

  for (const source of sources) {
    const rep: SourceReport = { source: source.name, fetched: 0, inserted: 0, duplicates: 0, filtered: 0 };
    out.reports.push(rep);
    let raws: RawItem[];
    try {
      raws = await source.fetch(sourceContext(d, source));
    } catch (e) {
      rep.error = errMsg(e);
      d.logger.warn(`ingest: fonte ${source.name} falhou: ${rep.error}`);
      continue;
    }
    rep.fetched = raws.length;

    const candidates: ReturnType<typeof RawItem.parse>[] = [];
    for (const input of raws) {
      const parsed = RawItem.safeParse(input);
      if (!parsed.success) {
        rep.filtered++;
        d.logger.warn(`ingest: item inválido de ${source.name}: ${parsed.error.issues[0]?.message}`);
        continue;
      }
      const raw = parsed.data;
      if (d.store.hasHash(sha(raw.dedupeKey))) {
        rep.duplicates++;
        continue;
      }
      if (raw.origin !== "manual") {
        const blocked = matchBlocked(`${raw.title ?? ""}\n${raw.text}`, p.editorial.blockedPatterns);
        if (blocked) {
          d.store.insertRaw(raw, { status: "skipped", reason: `prefiltro: padrão bloqueado (${blocked})` });
          rep.filtered++;
          continue;
        }
        const when = raw.postedAt ? Date.parse(raw.postedAt) : NaN;
        if (Number.isFinite(when) && (now - when) / HOUR > p.pipeline.maxItemAgeHours) {
          d.store.insertRaw(raw, { status: "skipped", reason: "prefiltro: antigo" });
          rep.filtered++;
          continue;
        }
      }
      candidates.push(raw);
    }

    candidates.sort((a, b) => engagementOf({ engagement: b.engagement }) - engagementOf({ engagement: a.engagement }));
    for (const [i, raw] of candidates.entries()) {
      if (i >= p.pipeline.maxNewPerSource) {
        d.store.insertRaw(raw, { status: "skipped", reason: "prefiltro: acima de maxNewPerSource" });
        rep.filtered++;
        continue;
      }
      // manual/profile items skip triage: they wait in "new" for the curator with a top score
      const direct = raw.origin !== "feed";
      const it = d.store.insertRaw(raw, direct ? { score: raw.origin === "manual" ? 100 : null, reason: raw.origin } : {});
      if (it) rep.inserted++;
      else rep.duplicates++;
    }
    out.inserted += rep.inserted;
  }
  return out;
}


export function summarizeIngest(r: IngestResult): string {
  const total = (k: "fetched" | "inserted" | "duplicates" | "filtered") => r.reports.reduce((n, x) => n + x[k], 0);
  const errs = r.reports.filter((x) => x.error);
  let s = `Lidas ${r.reports.length} fonte(s): ${total("fetched")} itens, ${total("inserted")} novos, ${total("duplicates")} repetidos, ${total("filtered")} filtrados.`;
  if (errs.length) s += ` Falhas: ${errs.map((e) => `${e.source} (${e.error})`).join("; ")}.`;
  return s;
}

// ------------------------------------------------------------------ triage

const TriageOutput = z.preprocess(unwrapArray, z.array(z.unknown())).transform((rows) =>
  rows.flatMap((x) => {
    const o = x as Record<string, unknown> | null;
    const id = typeof o?.id === "string" ? o.id : undefined;
    const raw = typeof o?.score === "number" ? o.score : typeof o?.relevance === "number" ? o.relevance : undefined;
    if (!id || raw === undefined) return [];
    const score = Math.max(0, Math.min(100, raw <= 1 && !Number.isInteger(raw) ? raw * 100 : raw));
    return [TriageEntry.parse({ id, score, reason: typeof o?.reason === "string" ? o.reason : "" })];
  }),
);

export interface TriageResult {
  scored: number;
  skipped: number;
  llmCalls: number;
  held?: string;
}

function failAttempt(d: JobDeps, item: Item, why: string): void {
  const n = d.store.bumpAttempts(item.id);
  if (n >= d.bundle.profile.pipeline.maxAttempts) d.store.transition(item.id, "skipped", `${why} (desistiu após ${n} tentativas)`);
}

/** Cheap-model scoring of new feed items, in batches. Below triageMinScore -> skipped. */
export async function triage(d: JobDeps): Promise<TriageResult> {
  const res: TriageResult = { scored: 0, skipped: 0, llmCalls: 0 };
  const p = d.bundle.profile.pipeline;
  const hold = budgetGate(d.store, d.bundle.models);
  if (hold) {
    d.logger.info(`triagem: em espera (${hold})`);
    return { ...res, held: hold };
  }
  const pending = d.store.list("new", 60, { origin: "feed" }).filter((i) => i.attempts < p.maxAttempts);
  for (let i = 0; i < pending.length; i += p.triageBatchSize) {
    const batch = pending.slice(i, i + p.triageBatchSize);
    const payload = {
      profile: { name: d.bundle.profile.name, language: d.bundle.profile.language },
      items: batch.map((r) => ({ id: r.id, source: r.source, author: r.author, title: r.title, text: r.text.slice(0, 900), engagement: r.engagement, postedAt: r.postedAt, hasImage: r.media.some((m) => m.type === "image") })),
    };
    let out: z.output<typeof TriageOutput>;
    try {
      res.llmCalls++;
      out = (await d.llm.json({ role: "triage", system: d.prompts.get("triage").text, user: JSON.stringify(payload), schema: TriageOutput, label: "triage" })).value;
    } catch (e) {
      if (e instanceof LlmOutputError) {
        for (const r of batch) failAttempt(d, r, "triagem: saída inválida do LLM");
        continue;
      }
      d.logger.warn(`triagem interrompida: ${errMsg(e)}`);
      break; // budget / key / http: leave untouched for the next tick
    }
    const byId = new Map(out.map((x) => [x.id, x]));
    for (const r of batch) {
      const x = byId.get(r.id);
      if (!x) {
        failAttempt(d, r, "triagem: sem resultado para o item");
        continue;
      }
      d.store.setScore(r.id, x.score, x.reason);
      if (x.score < p.triageMinScore) {
        d.store.transition(r.id, "skipped", `triagem: nota ${x.score.toFixed(0)}${x.reason ? " - " + x.reason : ""}`);
        res.skipped++;
      } else {
        d.store.transition(r.id, "scored", `triagem: ${x.score.toFixed(0)}`);
        res.scored++;
      }
    }
  }
  return res;
}

// ------------------------------------------------------------------ curate

export function curatorInput(d: Pick<JobDeps, "bundle">, item: Item, feedback?: string): string {
  return JSON.stringify({
    item: {
      id: item.id,
      origin: item.origin,
      source: item.source,
      sourceUrl: item.sourceUrl,
      author: item.author,
      title: item.title,
      text: item.text.slice(0, 4000),
      postedAt: item.postedAt,
      engagement: item.engagement,
      images: item.media.filter((m) => m.type === "image").length,
      videos: item.media.filter((m) => m.type === "video").length,
      extra: item.extra,
    },
    profile: { name: d.bundle.profile.name, language: d.bundle.profile.language },
    ...(feedback ? { feedback } : {}),
  });
}

/** One curator call + editorial policy. Does not touch the item. */
export async function curateOne(d: JobDeps, item: Item, feedback?: string): Promise<Draft> {
  const prompt = d.prompts.get("curator");
  const { value } = await d.llm.json({ role: "curator", system: prompt.text, user: curatorInput(d, item, feedback), schema: Draft, label: `curator:${item.id}` });
  const { draft, notes } = enforceEditorial({ ...value, promptVersion: prompt.version }, item, d.bundle.profile, d.bundle.template, { veto: d.veto });
  return withNotes(draft, notes);
}

/** Stores the draft and moves the item to curated, or to skipped (with a notice for manual items). */
export async function applyDraft(d: JobDeps, item: Item, draft: Draft): Promise<"curated" | "skipped"> {
  d.store.setDraft(item.id, draft);
  d.store.resetAttempts(item.id);
  if (draft.verdict === "skip") {
    const why = draft.skipReason ?? "nada a reportar";
    // pending_approval -> skipped is not a legal edge: pass through curated (regenerate flow)
    if (item.status === "pending_approval" || item.status === "ready") d.store.transition(item.id, "curated", "curador: refeito");
    d.store.transition(item.id, "skipped", `curador: ${why}`);
    if (item.origin === "manual") await notify(d, `Item descartado pelo curador: ${draft.headline}\nMotivo: ${why}`);
    return "skipped";
  }
  d.store.transition(item.id, "curated", `curador: ${draft.verdict}`);
  return "curated";
}

async function notify(d: JobDeps, text: string): Promise<void> {
  try {
    await d.notifier?.notify(text);
  } catch (e) {
    d.logger.warn(`notificação falhou: ${errMsg(e)}`);
  }
}

export interface CurateResult {
  curated: number;
  skipped: number;
  failed: number;
  held: number;
  holdReason?: string;
}

/** Curator over scored items (and new manual/profile items, which skip triage), honoring the queue gate. */
export async function curate(d: JobDeps): Promise<CurateResult> {
  const res: CurateResult = { curated: 0, skipped: 0, failed: 0, held: 0 };
  const p = d.bundle.profile.pipeline;
  const candidates = d.store
    .list(["scored", "new"], 100)
    .filter((i) => (i.status === "scored" || i.origin !== "feed") && i.attempts < p.maxAttempts);
  for (const item of candidates) {
    if (res.curated + res.skipped + res.failed >= p.curatorPerTick) break;
    const gate = queueGate({ store: d.store, profile: d.bundle.profile, models: d.bundle.models, paused: d.isPaused(), stage: "curate", score: item.score, manual: item.origin === "manual" });
    if (gate) {
      res.held++;
      res.holdReason = gate;
      continue;
    }
    try {
      const draft = await curateOne(d, item);
      const r = await applyDraft(d, item, draft);
      res[r === "curated" ? "curated" : "skipped"]++;
    } catch (e) {
      if (e instanceof LlmOutputError) {
        res.failed++;
        failAttempt(d, item, "curador: saída inválida do LLM");
        if (d.store.get(item.id)?.status === "skipped" && item.origin === "manual") await notify(d, "Não consegui curar o item adicionado (saída inválida do LLM repetidas vezes). Ele foi descartado.");
        continue;
      }
      // Falha do item (rede, provedor): conta a tentativa e segue para o próximo, que ainda pode ocupar a vaga do teto neste ciclo.
      if (e instanceof BudgetExceededError) {
        d.logger.warn(`curadoria interrompida: ${errMsg(e)}`);
        break;
      }
      res.failed++;
      failAttempt(d, item, `curador: ${errMsg(e)}`);
      continue;
    }
  }
  if (res.held) d.logger.info(`curadoria: ${res.held} item(ns) em espera (${res.holdReason})`);
  return res;
}

// ------------------------------------------------------------------ prepare

/** Runs the Preparer into <dataDir>/media/<id>/ and stores the result. Moves curated -> ready. */
export async function prepareOne(d: JobDeps, item: Item): Promise<Item> {
  if (!item.draft) throw new Error(`item ${item.id} sem rascunho`);
  const outDir = join(d.bundle.dataDir, "media", item.id);
  mkdirSync(outDir, { recursive: true });
  const prepared = await d.preparer.prepare(item, item.draft, { profile: d.bundle.profile, profileDir: d.bundle.profileDir, outDir, logger: d.logger });
  d.store.setPrepared(item.id, prepared);
  if (item.status === "curated") d.store.transition(item.id, "ready", `mídia pronta (${prepared.length})`);
  return d.store.get(item.id)!;
}

export interface PrepareResult {
  prepared: number;
  failed: number;
}

export async function prepare(d: JobDeps): Promise<PrepareResult> {
  const res: PrepareResult = { prepared: 0, failed: 0 };
  for (const item of d.store.list("curated", 20)) {
    if (!item.draft) continue;
    try {
      await prepareOne(d, item);
      res.prepared++;
    } catch (e) {
      res.failed++;
      d.logger.warn(`preparo de mídia falhou para ${item.id}: ${errMsg(e)}`);
      failAttempt(d, item, "mídia: falha ao preparar");
    }
  }
  return res;
}

// ------------------------------------------------------------------ present

export interface PresentResult {
  presented: number;
  held: number;
  holdReason?: string;
}

/** Sends one ready item to the notifier and moves it to pending_approval. Throws if there is no notifier. */
export async function presentOne(d: JobDeps, item: Item): Promise<Item> {
  if (!d.notifier) throw new Error("nenhum notifier configurado");
  const ids = await d.notifier.sendApproval(item);
  d.store.setTelegramMsgs(item.id, ids);
  return d.store.transition(item.id, "pending_approval", "enviado para aprovação");
}

/** Sends ready items for approval, honoring the gate and the per-author cooldown. */
export async function present(d: JobDeps): Promise<PresentResult> {
  const res: PresentResult = { presented: 0, held: 0 };
  if (!d.notifier) {
    d.logger.debug("apresentação: sem notifier");
    return res;
  }
  const cooldownMs = d.bundle.profile.pipeline.subjectCooldownHours * HOUR;
  for (const item of d.store.list("ready", 20)) {
    const manual = item.origin === "manual";
    const gate = queueGate({ store: d.store, profile: d.bundle.profile, models: { monthlyBudgetBRL: Number.POSITIVE_INFINITY }, paused: d.isPaused(), stage: "present", score: item.score, manual });
    if (gate) {
      res.held++;
      res.holdReason = gate;
      continue;
    }
    if (!manual && cooldownMs > 0 && item.author) {
      const last = d.store.lastPostAboutAuthor(item.author, item.id);
      if (last && d.clock.now().getTime() - last.getTime() < cooldownMs) {
        res.held++;
        res.holdReason = `carência de ${d.bundle.profile.pipeline.subjectCooldownHours}h para @${item.author}`;
        continue;
      }
    }
    try {
      await presentOne(d, item);
      res.presented++;
    } catch (e) {
      d.logger.warn(`envio para aprovação falhou (${item.id}): ${errMsg(e)}`);
    }
  }
  return res;
}

// ------------------------------------------------------------------ expire

export function expire(d: JobDeps): number {
  const cutoff = new Date(d.clock.now().getTime() - d.bundle.profile.pipeline.maxItemAgeHours * HOUR).toISOString();
  const n = d.store.expireOld(cutoff);
  if (n) d.logger.info(`expirados ${n} item(ns) antigos`);
  return n;
}
