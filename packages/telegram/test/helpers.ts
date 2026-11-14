import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REJECT_REASONS, type ApprovalUiConfig, type BotActions, type Destination, type Draft, type DestinationOutcome, type Item, type Publication, type Status, type StatusSnapshot, type StorePort } from "@auto-curator/contracts";
import { TelegramApi, TelegramBot } from "../src/index.js";

export interface Call {
  method: string;
  body: Record<string, any>;
  form?: FormData;
}

export function fakeFetch() {
  const calls: Call[] = [];
  let nextId = 100;
  const updates: unknown[][] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const isForm = init?.body instanceof FormData;
    calls.push({ method, body: isForm ? {} : JSON.parse(String(init?.body ?? "{}")), form: isForm ? (init!.body as FormData) : undefined });
    let result: unknown = true;
    if (method === "getUpdates") result = updates.shift() ?? [];
    else if (method.startsWith("send")) result = { message_id: nextId++ };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as typeof fetch;
  return { f, calls, updates, of: (m: string) => calls.filter((c) => c.method === m) };
}

export const dest = (platform: string, over: Partial<Destination> = {}): Destination => ({ platform, publisher: "manual", mode: "draft", dailyCap: 4, only: "any", ...over });

export const ui = (over: Partial<ApprovalUiConfig> = {}): ApprovalUiConfig => ({
  profileName: "Perfil Teste",
  credit: "show",
  destinations: [dest("instagram", { publisher: "buffer" }), dest("tiktok")],
  rejectReasons: DEFAULT_REJECT_REASONS,
  timezone: "America/Sao_Paulo",
  ...over,
});

export const draft = (over: Partial<Draft> = {}): Draft => ({
  verdict: "publish",
  headline: "Título do post",
  body: "Corpo do texto.",
  hashtags: ["#um", "#dois"],
  sourceCredit: "Reprodução Instagram @fonte",
  facts: [],
  riskFlags: [],
  confidence: 0.82,
  notes: "",
  extra: {},
  ...over,
});

export const item = (over: Partial<Item> = {}): Item => ({
  id: "p_ab12",
  dedupeHash: "h",
  origin: "feed",
  source: "src",
  sourceUrl: "https://example.com/post",
  author: "fonte",
  title: null,
  text: "texto original",
  media: [],
  postedAt: null,
  capturedAt: "2026-11-01T00:00:00Z",
  engagement: {},
  extra: {},
  status: "pending_approval",
  score: 80,
  reason: null,
  draft: draft(),
  prepared: [],
  telegramMsgIds: [],
  attempts: 0,
  priority: 0,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  ...over,
});

export class FakeStore implements StorePort {
  items = new Map<string, Item>();
  kv = new Map<string, string>();
  approvals: { id: string; action: string; reason?: string }[] = [];
  msgs: Record<string, number[]> = {};
  add(i: Item) {
    this.items.set(i.id, i);
    return i;
  }
  get(id: string) {
    return this.items.get(id);
  }
  list(status: Status | Status[], limit = 100) {
    const s = Array.isArray(status) ? status : [status];
    return [...this.items.values()].filter((i) => s.includes(i.status)).slice(0, limit);
  }
  count(status: Status | Status[]) {
    return this.list(status, 1e9).length;
  }
  transition(id: string, to: Status) {
    const i = this.items.get(id)!;
    i.status = to;
    return i;
  }
  setDraft(id: string, d: Draft) {
    this.items.get(id)!.draft = d;
  }
  setTelegramMsgs(id: string, ids: number[]) {
    this.msgs[id] = ids;
    const i = this.items.get(id);
    if (i) i.telegramMsgIds = ids;
  }
  setPriority(id: string, p: number) {
    this.items.get(id)!.priority = p;
  }
  recordApproval(id: string, action: string, reason?: string) {
    this.approvals.push({ id, action, reason });
  }
  listPublications(): Publication[] {
    return [];
  }
  kvGet(k: string) {
    return this.kv.get(k);
  }
  kvSet(k: string, v: string) {
    this.kv.set(k, v);
  }
  kvDel(k: string) {
    this.kv.delete(k);
  }
  monthSpendBRL() {
    return 0;
  }
  presentedToday() {
    return 0;
  }
}

export class FakeActions implements BotActions {
  log: string[] = [];
  paused = false;
  outcomes: DestinationOutcome[] = [{ platform: "instagram", kind: "buffer", mode: "queue", scheduledAt: "2026-11-09T16:15:00Z" }];
  constructor(private store: FakeStore) {}
  async addManual(input: string) {
    this.log.push(`add:${input}`);
    if (input === "bad") return { error: "link inválido" };
    return { item: this.store.add(item({ id: "p_new1", status: "new" })) };
  }
  async runPipeline() {
    this.log.push("runPipeline");
  }
  async ingestNow() {
    this.log.push("ingestNow");
    return "Li 3 fontes, 2 novos";
  }
  async regenerate(id: string, feedback?: string) {
    this.log.push(`regenerate:${id}:${feedback ?? ""}`);
  }
  async reprepare(id: string) {
    this.log.push(`reprepare:${id}`);
  }
  async approve(id: string) {
    this.log.push(`approve:${id}`);
    this.store.transition(id, "approved");
    return this.outcomes;
  }
  async reject(id: string, code: string) {
    this.log.push(`reject:${id}:${code}`);
    this.store.transition(id, "rejected");
  }
  async markPublished(id: string, platform: string) {
    this.log.push(`published:${id}:${platform}`);
  }
  async agenda() {
    this.log.push("agenda");
    return [{ platform: "instagram", label: "Post X", scheduledAt: "2026-11-09T16:15:00Z" }];
  }
  isPaused() {
    return this.paused;
  }
  setPaused(p: boolean) {
    this.paused = p;
    this.log.push(`paused:${p}`);
  }
  status(): StatusSnapshot {
    return { profileName: "Perfil Teste", paused: this.paused, counts: { pending_approval: 2, ready: 1 }, spendBRL: 12.5, budgetBRL: 50, presentedToday: 3, dailyApprovalCap: 8, gate: "Geração pausada: fila cheia" };
  }
}

export function setup(opts: { chats?: string[]; users?: string[]; uiOver?: Partial<ApprovalUiConfig> } = {}) {
  const net = fakeFetch();
  const store = new FakeStore();
  const actions = new FakeActions(store);
  const api = new TelegramApi("TOKEN", net.f);
  const bot = new TelegramBot({ api, allowedChatIds: opts.chats ?? ["1"], allowedUserIds: opts.users, store, actions, ui: ui(opts.uiOver), sleep: async () => {} });
  // long actions run detached from the poll loop: settle so assertions see their effects
  const text = async (t: string, chat = 1) => {
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: chat }, text: t } });
    await bot.settle();
  };
  const press = async (data: string, chat = 1, mid = 50) => {
    await bot.handleUpdate({ update_id: 2, callback_query: { id: "cq", data, message: { message_id: mid, chat: { id: chat } } } });
    await bot.settle();
  };
  const sent = () => net.of("sendMessage").map((c) => c.body.text as string);
  return { net, store, actions, bot, text, press, sent };
}

export function tmpFile(name: string, content = "x") {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}
