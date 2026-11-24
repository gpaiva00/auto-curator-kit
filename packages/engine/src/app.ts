import {
  KitError,
  charCount,
  composeText,
  destinationMaxChars,
  errMsg,
  silentLogger,
  systemClock,
  STATUSES,
  type BotActions,
  type Clock,
  type Destination,
  type DestinationOutcome,
  type Item,
  type LlmPort,
  type Logger,
  type Notifier,
  type PreparedMedia,
  type Preparer,
  type PromptProvider,
  type Publication,
  type Publisher,
  type RawItem,
  type Source,
  type SettingView,
  type StatusSnapshot,
} from "@auto-curator/contracts";
import type { ProfileBundle } from "./config.js";
import * as jobs from "./jobs.js";
import { loadVeto, queueGate, type VetoRules } from "./policy.js";
import { addDay, localInstant, nextSlot } from "./slots.js";
import { saveProfileSetting, settingViews } from "./settings.js";
import type { Store } from "./store.js";
import { dayKey } from "./util.js";

export interface AppDeps {
  bundle: ProfileBundle;
  store: Store;
  llm: LlmPort;
  prompts: PromptProvider;
  sources: Source[];
  preparer: Preparer;
  /** Keyed by publisher name: "buffer" (and any other automatic publisher). "manual" needs no entry. */
  publishers: Record<string, Publisher>;
  notifier?: Notifier;
  clock?: Clock;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  /** Preloaded veto rules; default: loaded from editorial.vetoFile. */
  veto?: VetoRules;
}

export interface TickResult {
  triage: jobs.TriageResult;
  curate: jobs.CurateResult;
  prepare: jobs.PrepareResult;
  present: jobs.PresentResult;
  expired: number;
}

const PAUSE_KEY = "paused";
const DEFAULT_MAX_DEFER_DAYS = 7;

/** Media shown/published on a destination, or undefined when the destination does not apply to this item. */
export function mediaForDestination(item: Item, dest: Destination): PreparedMedia[] | undefined {
  const eligible = item.prepared.filter((m) => (!m.platform || m.platform === dest.platform) && (dest.only === "any" || m.type === dest.only));
  // A platform-specific variant (e.g. the 9:16 TikTok video) replaces the generic media instead of adding to it.
  const variants = eligible.filter((m) => m.platform === dest.platform);
  const mine = variants.length ? variants : eligible.filter((m) => !m.platform);
  if (dest.only === "any") return mine;
  return mine.length ? mine : undefined;
}

export class App implements BotActions {
  readonly bundle: ProfileBundle;
  readonly store: Store;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly jobDeps: jobs.JobDeps;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: AppDeps) {
    this.bundle = d.bundle;
    this.store = d.store;
    this.clock = d.clock ?? systemClock;
    this.log = d.logger ?? silentLogger;
    this.jobDeps = {
      bundle: d.bundle,
      store: d.store,
      llm: d.llm,
      prompts: d.prompts,
      preparer: d.preparer,
      notifier: d.notifier,
      veto: d.veto ?? loadVeto(d.bundle.profileDir, d.bundle.profile.editorial, this.log),
      clock: this.clock,
      logger: this.log,
      env: d.env ?? process.env,
      isPaused: () => this.isPaused(),
    };
  }

  /** Resolves once every queued pipeline step has finished (use before closing the store). */
  async idle(): Promise<void> {
    let c: Promise<unknown>;
    do {
      c = this.chain;
      await c;
    } while (c !== this.chain);
  }

  /** Pipeline steps never overlap (SQLite single writer, predictable LLM spend). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  // ------------------------------------------------------------ pipeline

  ingest(): Promise<jobs.IngestResult> {
    return this.exclusive(() => jobs.ingest(this.jobDeps, this.d.sources));
  }

  async ingestNow(): Promise<string> {
    return jobs.summarizeIngest(await this.ingest());
  }

  /** triage -> curate -> prepare -> present (plus expiry of old items). */
  tick(): Promise<TickResult> {
    return this.exclusive(async () => {
      const j = this.jobDeps;
      const expired = jobs.expire(j);
      if (this.isPaused()) {
        this.log.info("tick: pausado");
        const z = { scored: 0, skipped: 0, llmCalls: 0 };
        return { triage: z, curate: { curated: 0, skipped: 0, failed: 0, held: 0 }, prepare: { prepared: 0, failed: 0 }, present: { presented: 0, held: 0 }, expired };
      }
      const triage = await jobs.triage(j);
      const curate = await jobs.curate(j);
      const prepare = await jobs.prepare(j);
      const present = await jobs.present(j);
      return { triage, curate, prepare, present, expired };
    });
  }

  async runPipeline(): Promise<void> {
    await this.tick();
  }

  // ------------------------------------------------------------ manual input

  async addManual(input: string): Promise<{ item?: Item; error?: string }> {
    const text = input.trim();
    if (!text) return { error: "Nada para adicionar: envie um link ou um texto." };
    let raw: RawItem | undefined;
    let lastError: string | undefined;
    for (const s of this.d.sources) {
      if (!s.fromInput) continue;
      try {
        raw = await s.fromInput(text, jobs.sourceContext(this.jobDeps, s));
      } catch (e) {
        lastError = errMsg(e);
        this.log.warn(`addManual: ${s.name} falhou: ${lastError}`);
      }
      if (raw) break;
    }
    if (!raw) {
      if (/^https?:\/\/\S+$/i.test(text)) return { error: lastError ?? "Nenhuma fonte configurada sabe ler esse link. Cole o texto do conteúdo." };
      raw = { dedupeKey: `text:${text.replace(/\s+/g, " ").toLowerCase()}`, origin: "manual", source: "manual", author: "", text };
    }
    const item = this.store.insertRaw({ ...raw, origin: "manual" }, { score: 100, reason: "manual" });
    return item ? { item } : { error: "Esse item já foi adicionado." };
  }

  // ------------------------------------------------------------ approval flow

  /** 🔁 Refazer: re-runs the curator with feedback, prepares and re-sends right away (gate ignored). */
  regenerate(id: string, feedback?: string): Promise<void> {
    return this.exclusive(async () => {
      const item = this.mustGet(id, "pending_approval");
      const draft = await jobs.curateOne(this.jobDeps, item, feedback);
      this.store.recordApproval(id, "regenerate", feedback);
      const r = await jobs.applyDraft(this.jobDeps, item, draft);
      if (r === "skipped") return;
      const ready = await jobs.prepareOne(this.jobDeps, this.store.get(id)!);
      await jobs.presentOne(this.jobDeps, ready);
    });
  }

  /** /refazer: pendente ou aprovado sem publicação na fila volta à curadoria com a instrução. Fila e publicado são recusados. */
  async refazer(id: string, feedback?: string): Promise<void> {
    const item = this.store.get(id);
    if (!item) throw new KitError("Item não encontrado.", "NOT_FOUND");
    // Fila primeiro: um item agendado no Buffer já está "published" e precisa da mensagem de fila.
    if (this.store.publicationsOf(id).some((p) => p.status === "queued" || p.status === "scheduled")) {
      throw new KitError("Este item já está na fila de envio; não dá para refazer sem cancelar antes.", "IN_QUEUE");
    }
    if (item.status === "published") throw new KitError("Este item já foi publicado; não dá para refazer.", "ALREADY_PUBLISHED");
    if (item.status === "approved") this.store.transition(id, "pending_approval", "refazer: voltou à aprovação");
    return this.regenerate(id, feedback);
  }

  /** After edits: re-prepare media and re-send the card (old cards are left to the bot). */
  reprepare(id: string): Promise<void> {
    return this.exclusive(async () => {
      const item = this.mustGet(id, "pending_approval");
      this.store.transition(id, "ready", "reprocessar mídia");
      const ready = await jobs.prepareOne(this.jobDeps, { ...this.store.get(id)!, draft: item.draft });
      await jobs.presentOne(this.jobDeps, ready);
    });
  }

  async reject(id: string, reasonCode: string): Promise<void> {
    this.mustGet(id, "pending_approval");
    this.store.recordApproval(id, "reject", reasonCode);
    this.store.transition(id, "rejected", `rejeitado: ${reasonCode}`);
  }

  /** Primeiro horário com vaga no teto diário do destino (janela e intervalo respeitados); undefined sem vaga em maxDeferDays. */
  private findSlot(dest: Destination, now: Date): Date | undefined {
    const tz = this.bundle.profile.timezone;
    const days = dest.maxDeferDays ?? DEFAULT_MAX_DEFER_DAYS;
    let slot = nextSlot(now, dest, this.store.lastSlotAt(dest.platform), tz);
    for (let i = 0; i <= days; i++) {
      const day = dayKey(slot, tz);
      if (this.store.publicationsOnDay(dest.platform, day) < dest.dailyCap) return slot;
      // Dia cheio: recomeça no horário de abertura do destino (janela ou 09:00) do dia seguinte.
      slot = nextSlot(localInstant(addDay(day), dest.window?.start ?? "09:00", tz), dest, this.store.lastSlotAt(dest.platform), tz);
    }
    return undefined;
  }

  async approve(id: string): Promise<DestinationOutcome[]> {
    const item = this.mustGet(id, "pending_approval");
    if (!item.draft) throw new KitError(`Item ${id} sem rascunho`, "NO_DRAFT");
    this.store.recordApproval(id, "approve");
    this.store.transition(id, "approved", "aprovado");
    const text = composeText(item.draft, { credit: this.bundle.profile.editorial.credit });
    const outcomes: DestinationOutcome[] = [];
    let attempted = 0;
    let buffered = 0;
    const dests = this.bundle.profile.destinations;

    for (const dest of dests) {
      const media = mediaForDestination(item, dest);
      if (!media) continue; // destination does not take this kind of media
      attempted++;
      const max = destinationMaxChars(dest);
      if (dest.publisher !== "manual" && max !== undefined && charCount(text) > max) {
        const note = `texto de ${charCount(text)} caracteres passa do limite de ${max}`;
        this.store.addPublication({ itemId: id, platform: dest.platform, publisher: "manual", status: "manual", error: note });
        outcomes.push({ platform: dest.platform, kind: "manual", error: note });
        continue;
      }
      if (dest.publisher !== "manual") {
        const pub = this.d.publishers[dest.publisher];
        const now = this.clock.now();
        // Teto diário, janela e intervalo juntos: o primeiro horário com vaga; sem vaga em maxDeferDays, vai para manual.
        const slot = this.findSlot(dest, now);
        if (!slot) {
          const note = `sem vaga nos próximos ${dest.maxDeferDays ?? DEFAULT_MAX_DEFER_DAYS} dias (teto diário de ${dest.dailyCap})`;
          this.store.addPublication({ itemId: id, platform: dest.platform, publisher: "manual", status: "manual", error: note });
          outcomes.push({ platform: dest.platform, kind: "manual", error: note });
          continue;
        }
        if (slot.getTime() > now.getTime()) {
          // Channel interval or window says "not yet": keep it locally until releaseDue() sends it.
          this.store.addPublication({ itemId: id, platform: dest.platform, publisher: dest.publisher, status: "queued", mode: dest.mode, scheduledAt: slot.toISOString() });
          outcomes.push({ platform: dest.platform, kind: "queued", scheduledAt: slot.toISOString() });
          buffered++;
          continue;
        }
        try {
          if (!pub) throw new KitError(`publicador ${dest.publisher} não configurado`, "NO_PUBLISHER");
          const res = await pub.publish({ item, destination: dest, text, firstComment: item.draft.firstComment, media });
          this.store.addPublication({ itemId: id, platform: dest.platform, publisher: dest.publisher, status: "scheduled", externalId: res.externalId, mode: res.mode, scheduledAt: res.scheduledAt });
          outcomes.push({ platform: dest.platform, kind: "buffer", mode: res.mode, scheduledAt: res.scheduledAt, droppedMedia: res.droppedMedia });
          buffered++;
          continue;
        } catch (e) {
          this.log.warn(`buffer falhou (${dest.platform}): ${errMsg(e)}`);
          this.store.addPublication({ itemId: id, platform: dest.platform, publisher: dest.publisher, status: "failed", error: errMsg(e) });
          outcomes.push({ platform: dest.platform, kind: "failed", error: errMsg(e) });
          continue;
        }
      }
      this.store.addPublication({ itemId: id, platform: dest.platform, publisher: "manual", status: "manual" });
      outcomes.push({ platform: dest.platform, kind: "manual" });
    }
    if (attempted === 0) {
      // No destination takes this media: keep it approved and let the human post by hand on the first destination.
      const first = dests[0]!;
      const note = "nenhum destino aceita a mídia deste item; poste manualmente";
      this.store.addPublication({ itemId: id, platform: first.platform, publisher: "manual", status: "manual", error: note });
      outcomes.push({ platform: first.platform, kind: "manual", error: note });
    } else if (buffered === attempted) {
      this.store.transition(id, "published", "agendado no Buffer");
    }
    return outcomes;
  }

  /** Sends queued posts whose slot has come. Runs on the "publish" interval. */
  releaseDue(): Promise<string> {
    return this.exclusive(async () => {
      const now = this.clock.now();
      let sent = 0;
      let failed = 0;
      for (const p of this.store.dueQueued(now)) {
        try {
          const item = this.store.get(p.itemId);
          const dest = this.bundle.profile.destinations.find((d) => d.platform === p.platform && d.publisher === p.publisher);
          const pub = this.d.publishers[p.publisher];
          if (!item?.draft || !dest) throw new KitError("item ou destino não existe mais", "NOT_FOUND");
          if (!pub) throw new KitError(`publicador ${p.publisher} não configurado`, "NO_PUBLISHER");
          const media = mediaForDestination(item, dest) ?? [];
          const text = composeText(item.draft, { credit: this.bundle.profile.editorial.credit });
          const res = await pub.publish({ item, destination: dest, text, firstComment: item.draft.firstComment, media });
          this.store.updatePublication(p.id, { status: "scheduled", externalId: res.externalId, mode: res.mode, scheduledAt: res.scheduledAt ?? null });
          sent++;
        } catch (e) {
          this.log.warn(`envio da fila falhou (${p.platform}): ${errMsg(e)}`);
          this.store.updatePublication(p.id, { status: "failed", error: errMsg(e) });
          failed++;
        }
      }
      return `fila: ${sent} enviado(s), ${failed} com falha`;
    });
  }

  async markPublished(id: string, platform: string): Promise<void> {
    const item = this.store.get(id);
    if (!item) throw new KitError(`Item ${id} não encontrado`, "NOT_FOUND");
    if (item.status === "published") return;
    if (item.status !== "approved") throw new KitError(`Item ${id} está em ${item.status}, não em approved`, "ILLEGAL_STATE");
    const pubs = this.store.publicationsOf(id);
    const open = pubs.find((p) => p.platform === platform && (p.status === "manual" || p.status === "failed"));
    if (!open) throw new KitError(`Nenhuma publicação manual pendente em ${platform}`, "NOT_FOUND");
    this.store.updatePublication(open.id, { status: "published" });
    this.store.recordApproval(id, "published_manual", platform);
    const left = this.store.publicationsOf(id).some((p) => p.status === "manual" || p.status === "failed");
    if (!left) this.store.transition(id, "published", "publicado manualmente");
  }

  // ------------------------------------------------------------ status

  async agenda(): Promise<{ platform: string; label: string; scheduledAt?: string }[]> {
    const rows = new Map<string, { platform: string; label: string; scheduledAt?: string }>();
    const local = this.store.listPublications({ status: ["scheduled", "queued"], limit: 50 });
    for (const p of local) {
      const label = this.store.get(p.itemId)?.draft?.headline ?? p.itemId;
      rows.set(p.externalId ?? p.id, { platform: p.platform, label, scheduledAt: p.scheduledAt ?? undefined });
    }
    for (const pub of Object.values(this.d.publishers)) {
      if (!pub.listScheduled) continue;
      try {
        for (const s of await pub.listScheduled()) rows.set(s.externalId, { platform: s.platform, label: s.text.replace(/\s+/g, " ").slice(0, 70), scheduledAt: s.scheduledAt });
      } catch (e) {
        this.log.warn(`agenda: ${pub.name} falhou: ${errMsg(e)}`);
      }
    }
    return [...rows.values()].sort((a, b) => (a.scheduledAt ?? "9").localeCompare(b.scheduledAt ?? "9"));
  }

  isPaused(): boolean {
    return this.store.kvGet(PAUSE_KEY) === "1";
  }
  setPaused(p: boolean): void {
    if (p) this.store.kvSet(PAUSE_KEY, "1");
    else this.store.kvDel(PAUSE_KEY);
  }

  settings(): SettingView[] {
    return settingViews(this.bundle.profile);
  }

  async setSetting(key: string, raw: string): Promise<SettingView> {
    return saveProfileSetting(this.bundle.profileDir, key, raw);
  }

  status(): StatusSnapshot {
    const profile = this.bundle.profile;
    const counts = this.store.countsByStatus();
    return {
      profileName: profile.name,
      paused: this.isPaused(),
      counts: Object.fromEntries(STATUSES.flatMap((s) => (counts[s] ? [[s, counts[s]]] : []))),
      spendBRL: this.store.monthSpendBRL(),
      budgetBRL: this.bundle.models.monthlyBudgetBRL,
      presentedToday: this.store.presentedToday(),
      dailyApprovalCap: profile.pipeline.dailyApprovalCap,
      gate: queueGate({ store: this.store, profile, models: this.bundle.models, paused: false, stage: "curate" }),
    };
  }

  private mustGet(id: string, expected: Item["status"]): Item {
    const item = this.store.get(id);
    if (!item) throw new KitError(`Item ${id} não encontrado`, "NOT_FOUND");
    if (item.status !== expected) throw new KitError(`Item ${id} já está em ${item.status}`, "ILLEGAL_TRANSITION");
    return item;
  }
}

