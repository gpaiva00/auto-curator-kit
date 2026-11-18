import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ModelsConfig,
  ProfileConfig,
  TemplateConfig,
  type Clock,
  type Draft,
  type DraftInput,
  type Item,
  type JsonRequest,
  type LlmPort,
  type LlmRole,
  type Notifier,
  type PrepareContext,
  type PreparedMedia,
  type Preparer,
  type ProfileConfigInput,
  type PublishRequest,
  type PublishResult,
  type Publisher,
  type RawItem,
  type Source,
  type SourceContext,
} from "@auto-curator/contracts";
import type { ProfileBundle } from "./config.js";
import { LlmOutputError } from "./llm.js";

export type FakeResponse = unknown | Error | ((req: JsonRequest<unknown>) => unknown);

/**
 * Scripted LLM: responses per role are consumed in order (the last one repeats). Values pass through the request's
 * zod schema, so schema defaults and validation behave like the real client (invalid -> LlmOutputError).
 */
export class FakeLlm implements LlmPort {
  readonly calls: { role: LlmRole; system: string; user: string; label?: string }[] = [];
  private readonly queues: Record<LlmRole, FakeResponse[]>;
  costBRL = 0.01;

  constructor(script: Partial<Record<LlmRole, FakeResponse | FakeResponse[]>> = {}) {
    const q = (v: FakeResponse | FakeResponse[] | undefined): FakeResponse[] => (v === undefined ? [] : Array.isArray(v) ? [...v] : [v]);
    this.queues = { triage: q(script.triage), curator: q(script.curator) };
  }

  push(role: LlmRole, ...r: FakeResponse[]): void {
    this.queues[role].push(...r);
  }

  async json<T>(req: JsonRequest<T>): Promise<{ value: T; costBRL: number; model: string }> {
    this.calls.push({ role: req.role, system: req.system, user: req.user, label: req.label });
    const q = this.queues[req.role];
    if (!q.length) throw new Error(`FakeLlm: sem resposta roteirizada para ${req.role}`);
    const next = q.length > 1 ? q.shift()! : q[0]!;
    const resp = typeof next === "function" ? (next as (r: JsonRequest<unknown>) => unknown)(req as JsonRequest<unknown>) : next;
    if (resp instanceof Error) throw resp;
    const r = req.schema.safeParse(resp);
    if (!r.success) throw new LlmOutputError(`FakeLlm: saída inválida: ${r.error.message}`, JSON.stringify(resp));
    return { value: r.data, costBRL: this.costBRL, model: "fake" };
  }
}

/** A valid Draft input; override what a test cares about. */
export function okDraft(over: Partial<DraftInput> = {}): DraftInput {
  return {
    verdict: "publish",
    headline: "Título de teste",
    body: "Texto de teste com mais de vinte caracteres, pronto para publicar.",
    hashtags: ["#teste"],
    sourceCredit: "Fonte: Fulano",
    facts: [],
    riskFlags: [],
    confidence: 0.9,
    notes: "",
    extra: {},
    ...over,
  };
}

export class FakeSource implements Source {
  readonly type = "fake";
  fetchCount = 0;
  constructor(
    readonly name = "fake",
    public items: RawItem[] = [],
    private readonly opts: { fail?: Error; fromInput?: (input: string) => RawItem | undefined } = {},
  ) {
    if (opts.fromInput) this.fromInput = async (input: string) => opts.fromInput!(input);
  }
  fromInput?: (input: string, ctx?: SourceContext) => Promise<RawItem | undefined>;
  async fetch(_ctx: SourceContext): Promise<RawItem[]> {
    this.fetchCount++;
    if (this.opts.fail) throw this.opts.fail;
    return this.items;
  }
}

export class FakePreparer implements Preparer {
  readonly strategy = "none" as const;
  readonly calls: string[] = [];
  constructor(private readonly media: "none" | "image" | "image+video" = "image") {}
  async prepare(item: Item, _draft: Draft, ctx: PrepareContext): Promise<PreparedMedia[]> {
    this.calls.push(item.id);
    mkdirSync(ctx.outDir, { recursive: true });
    const out: PreparedMedia[] = [];
    if (this.media !== "none") {
      const p = join(ctx.outDir, "card.png");
      writeFileSync(p, "fake");
      out.push({ type: "image", localPath: p, thirdParty: false });
    }
    if (this.media === "image+video") {
      const p = join(ctx.outDir, "clip.mp4");
      writeFileSync(p, "fake");
      out.push({ type: "video", localPath: p, thirdParty: false });
    }
    return out;
  }
}

export class FakePublisher implements Publisher {
  readonly requests: PublishRequest[] = [];
  scheduled: { externalId: string; platform: string; text: string; scheduledAt?: string }[] | undefined;
  constructor(readonly name = "buffer", public failWith?: Error) {}
  async publish(req: PublishRequest): Promise<PublishResult> {
    if (this.failWith) throw this.failWith;
    this.requests.push(req);
    return { externalId: `ext_${this.requests.length}`, mode: req.destination.mode, scheduledAt: "2026-11-15T12:00:00.000Z" };
  }
  async listScheduled() {
    return this.scheduled ?? [];
  }
}

export class RecordingNotifier implements Notifier {
  readonly approvals: Item[] = [];
  readonly notices: string[] = [];
  private nextId = 100;
  async sendApproval(item: Item): Promise<number[]> {
    this.approvals.push(item);
    return [this.nextId++];
  }
  async notify(text: string): Promise<void> {
    this.notices.push(text);
  }
}

export interface FixedClock extends Clock {
  set(iso: string): void;
  advanceMs(ms: number): void;
}
export function fixedClock(iso = "2026-11-14T15:00:00.000Z"): FixedClock {
  let t = new Date(iso).getTime();
  return { now: () => new Date(t), set: (s) => void (t = new Date(s).getTime()), advanceMs: (ms) => void (t += ms) };
}

const ROLE = { baseUrl: "https://llm.example.test/v1", apiKeyEnv: "TEST_KEY", model: "m", inputUsdPerM: 1, outputUsdPerM: 2 };

/** In-memory ProfileBundle for tests and dry-runs (no files read). `dataDir` should be a temp dir. */
export function makeBundle(dataDir: string, profile: Partial<ProfileConfigInput> = {}, template: Partial<TemplateConfig> = {}): ProfileBundle {
  return {
    profile: ProfileConfig.parse({ id: "teste", name: "Perfil Teste", destinations: [{ platform: "linkedin", publisher: "manual" }], ...profile }),
    template: TemplateConfig.parse({ name: "test", ...template }),
    templateDir: join(dataDir, "template"),
    models: ModelsConfig.parse({ monthlyBudgetBRL: 50, roles: { triage: ROLE, curator: ROLE } }),
    profileDir: join(dataDir, "profile"),
    dataDir,
    warnings: [],
  };
}
