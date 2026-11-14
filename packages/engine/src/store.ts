import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  KitError,
  RawItem,
  STATUSES,
  canTransition,
  systemClock,
  type Clock,
  type Draft,
  type Item,
  type Media,
  type PreparedMedia,
  type Publication,
  type RawItemParsed,
  type Status,
  type StorePort,
} from "@auto-curator/contracts";
import { dayKey, monthKey, newId, sha256 } from "./util.js";

// node:sqlite through createRequire: vite/vitest cannot resolve the `node:sqlite` specifier.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
export type Db = DatabaseSyncType;

/** Numbered, append-only migrations. Never edit an applied one: add a new entry. */
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "initial",
    sql: `
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  dedupe_hash TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT,
  author TEXT NOT NULL DEFAULT '',
  title TEXT,
  text TEXT NOT NULL,
  media_json TEXT NOT NULL DEFAULT '[]',
  posted_at TEXT,
  captured_at TEXT NOT NULL,
  engagement_json TEXT NOT NULL DEFAULT '{}',
  extra_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  score REAL,
  reason TEXT,
  draft_json TEXT,
  prepared_json TEXT NOT NULL DEFAULT '[]',
  telegram_msg_ids TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_author ON items(author);
CREATE TABLE transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  at TEXT NOT NULL
);
CREATE INDEX idx_transitions_item ON transitions(item_id);
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);
CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  publisher TEXT NOT NULL,
  external_id TEXT,
  mode TEXT,
  status TEXT NOT NULL,
  scheduled_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_publications_item ON publications(item_id);
CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  month TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_brl REAL NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX idx_llm_usage_month ON llm_usage(month);
CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  summary TEXT,
  error TEXT
);`,
  },
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function migrate(db: Db): number[] {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const done = new Set((db.prepare("SELECT id FROM _migrations").all() as { id: number }[]).map((r) => r.id));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?,?,?)").run(m.id, m.name, new Date().toISOString());
      db.exec("COMMIT");
      applied.push(m.id);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return applied;
}

type Row = Record<string, unknown>;
const json = <T>(v: unknown, fallback: T): T => {
  try {
    return v ? (JSON.parse(v as string) as T) : fallback;
  } catch {
    return fallback;
  }
};

const toItem = (r: Row): Item => ({
  id: r.id as string,
  dedupeHash: r.dedupe_hash as string,
  origin: r.origin as Item["origin"],
  source: r.source as string,
  sourceUrl: (r.source_url as string | null) ?? null,
  author: r.author as string,
  title: (r.title as string | null) ?? null,
  text: r.text as string,
  media: json<Media[]>(r.media_json, []),
  postedAt: (r.posted_at as string | null) ?? null,
  capturedAt: r.captured_at as string,
  engagement: json(r.engagement_json, {}),
  extra: json(r.extra_json, {}),
  status: r.status as Status,
  score: (r.score as number | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  draft: json<Draft | null>(r.draft_json, null),
  prepared: json<PreparedMedia[]>(r.prepared_json, []),
  telegramMsgIds: json<number[]>(r.telegram_msg_ids, []),
  attempts: r.attempts as number,
  priority: r.priority as number,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toPublication = (r: Row): Publication => ({
  id: r.id as string,
  itemId: r.item_id as string,
  platform: r.platform as string,
  publisher: r.publisher as string,
  externalId: (r.external_id as string | null) ?? null,
  mode: (r.mode as string | null) ?? null,
  status: r.status as Publication["status"],
  scheduledAt: (r.scheduled_at as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  createdAt: r.created_at as string,
});

export interface StoreOptions {
  /** File path or ":memory:". */
  path: string;
  timezone?: string;
  clock?: Clock;
}

export interface InsertRawOptions {
  status?: Status;
  score?: number | null;
  reason?: string | null;
}

export interface TransitionRow {
  itemId: string;
  from: Status | null;
  to: Status;
  note: string | null;
  at: string;
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/** The only table owner: SQLite through node:sqlite, one `items` table plus logs. Implements StorePort. */
export class Store implements StorePort {
  readonly db: Db;
  readonly timezone: string;
  private readonly clock: Clock;

  constructor(opts: StoreOptions | string = ":memory:") {
    const o = typeof opts === "string" ? { path: opts } : opts;
    this.db = openDb(o.path);
    this.timezone = o.timezone ?? "America/Sao_Paulo";
    this.clock = o.clock ?? systemClock;
  }

  close(): void {
    this.db.close();
  }

  private now = (): string => this.clock.now().toISOString();

  // ------------------------------------------------------------ items

  hasHash(hash: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM items WHERE dedupe_hash = ?").get(hash);
  }
  static hashOf(dedupeKey: string): string {
    return sha256(dedupeKey);
  }

  /** Inserts a RawItem (dedupe by sha256(dedupeKey)). Returns undefined when it already exists. */
  insertRaw(raw: RawItem, opts: InsertRawOptions = {}): Item | undefined {
    const r: RawItemParsed = RawItem.parse(raw);
    const hash = sha256(r.dedupeKey);
    if (this.hasHash(hash)) return undefined;
    const t = this.now();
    const id = newId("i_");
    const status = opts.status ?? "new";
    this.db
      .prepare(
        `INSERT INTO items (id, dedupe_hash, origin, source, source_url, author, title, text, media_json, posted_at, captured_at, engagement_json, extra_json, status, score, reason, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, hash, r.origin, r.source, r.sourceUrl ?? null, r.author, r.title ?? null, r.text, JSON.stringify(r.media), r.postedAt ?? null, t, JSON.stringify(r.engagement), JSON.stringify(r.extra), status, opts.score ?? null, opts.reason ?? null, t, t);
    this.log(id, null, status, opts.reason ?? undefined);
    return this.get(id);
  }

  get(id: string): Item | undefined {
    const r = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
    return r ? toItem(r) : undefined;
  }

  /** Highest priority first, then best score, then oldest. */
  list(status: Status | Status[], limit = 100, opts: { origin?: Item["origin"] } = {}): Item[] {
    const sts = Array.isArray(status) ? status : [status];
    if (opts.origin) {
      const q = `SELECT * FROM items WHERE status IN (${placeholders(sts.length)}) AND origin = ? ORDER BY priority DESC, COALESCE(score, 0) DESC, created_at ASC LIMIT ?`;
      return (this.db.prepare(q).all(...sts, opts.origin, limit) as Row[]).map(toItem);
    }
    const q = `SELECT * FROM items WHERE status IN (${placeholders(sts.length)}) ORDER BY priority DESC, COALESCE(score, 0) DESC, created_at ASC LIMIT ?`;
    return (this.db.prepare(q).all(...sts, limit) as Row[]).map(toItem);
  }

  count(status: Status | Status[]): number {
    const sts = Array.isArray(status) ? status : [status];
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE status IN (${placeholders(sts.length)})`).get(...sts) as { n: number }).n;
  }

  countsByStatus(): Partial<Record<Status, number>> {
    const out: Partial<Record<Status, number>> = {};
    for (const s of STATUSES) {
      const n = this.count(s);
      if (n) out[s] = n;
    }
    return out;
  }

  private log(id: string, from: Status | null, to: Status, note?: string): void {
    this.db.prepare("INSERT INTO transitions (item_id, from_status, to_status, note, at) VALUES (?,?,?,?,?)").run(id, from, to, note ?? null, this.now());
  }

  /** Enforces the contracts state machine. Throws KitError(..., "ILLEGAL_TRANSITION") or "NOT_FOUND". */
  transition(id: string, to: Status, note?: string): Item {
    const cur = this.get(id);
    if (!cur) throw new KitError(`Item ${id} não encontrado`, "NOT_FOUND");
    if (!canTransition(cur.status, to)) throw new KitError(`Transição ilegal: ${cur.status} -> ${to} (item ${id})`, "ILLEGAL_TRANSITION");
    this.db.prepare("UPDATE items SET status = ?, reason = COALESCE(?, reason), updated_at = ? WHERE id = ?").run(to, note ?? null, this.now(), id);
    this.log(id, cur.status, to, note);
    return this.get(id)!;
  }

  transitionsOf(id: string): TransitionRow[] {
    return (this.db.prepare("SELECT * FROM transitions WHERE item_id = ? ORDER BY id").all(id) as Row[]).map((r) => ({
      itemId: r.item_id as string,
      from: (r.from_status as Status | null) ?? null,
      to: r.to_status as Status,
      note: (r.note as string | null) ?? null,
      at: r.at as string,
    }));
  }

  approvalsOf(id: string): { action: string; reason: string | null; at: string }[] {
    return (this.db.prepare("SELECT action, reason, at FROM approvals WHERE item_id = ? ORDER BY id").all(id) as Row[]).map((r) => ({
      action: r.action as string,
      reason: (r.reason as string | null) ?? null,
      at: r.at as string,
    }));
  }

  private touch(sql: string, ...args: (string | number | null)[]): void {
    this.db.prepare(sql).run(...args);
  }
  setDraft(id: string, draft: Draft): void {
    this.touch("UPDATE items SET draft_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(draft), this.now(), id);
  }
  setPrepared(id: string, prepared: PreparedMedia[]): void {
    this.touch("UPDATE items SET prepared_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(prepared), this.now(), id);
  }
  setScore(id: string, score: number, reason?: string): void {
    this.touch("UPDATE items SET score = ?, reason = COALESCE(?, reason), updated_at = ? WHERE id = ?", score, reason ?? null, this.now(), id);
  }
  setTelegramMsgs(id: string, ids: number[]): void {
    this.touch("UPDATE items SET telegram_msg_ids = ?, updated_at = ? WHERE id = ?", JSON.stringify(ids), this.now(), id);
  }
  setPriority(id: string, priority: number): void {
    this.touch("UPDATE items SET priority = ?, updated_at = ? WHERE id = ?", priority, this.now(), id);
  }
  /** Returns the new attempts count. */
  bumpAttempts(id: string): number {
    this.touch("UPDATE items SET attempts = attempts + 1, updated_at = ? WHERE id = ?", this.now(), id);
    return this.get(id)!.attempts;
  }
  resetAttempts(id: string): void {
    this.touch("UPDATE items SET attempts = 0, updated_at = ? WHERE id = ?", this.now(), id);
  }

  /** Unfinished, non-manual items created before `cutoffIso` become skipped("expired"). Returns how many. */
  expireOld(cutoffIso: string): number {
    const rows = this.db
      .prepare("SELECT id FROM items WHERE status IN ('new','scored','curated','ready') AND origin != 'manual' AND created_at < ?")
      .all(cutoffIso) as { id: string }[];
    for (const r of rows) this.transition(r.id, "skipped", "expirado");
    return rows.length;
  }

  /** Most recent time an item by this author was presented/approved/published (excluding `exceptId`). For the subject cooldown. */
  lastPostAboutAuthor(author: string, exceptId?: string): Date | undefined {
    if (!author.trim()) return undefined;
    const r = this.db
      .prepare(
        `SELECT MAX(t.at) AS at FROM transitions t JOIN items i ON i.id = t.item_id
         WHERE lower(i.author) = lower(?) AND t.to_status IN ('pending_approval','approved','published') AND i.id != ? AND i.status NOT IN ('rejected','skipped')`,
      )
      .get(author, exceptId ?? "") as { at: string | null };
    return r.at ? new Date(r.at) : undefined;
  }

  /** Items presented for approval today (local day, each item counted once). */
  presentedToday(): number {
    const today = dayKey(this.clock.now(), this.timezone);
    const rows = this.db.prepare("SELECT item_id, at FROM transitions WHERE to_status = 'pending_approval'").all() as { item_id: string; at: string }[];
    return new Set(rows.filter((r) => dayKey(new Date(r.at), this.timezone) === today).map((r) => r.item_id)).size;
  }

  // ------------------------------------------------------------ approvals / publications

  recordApproval(id: string, action: "approve" | "reject" | "edit_body" | "edit_headline" | "regenerate" | "published_manual", reason?: string): void {
    this.touch("INSERT INTO approvals (item_id, action, reason, at) VALUES (?,?,?,?)", id, action, reason ?? null, this.now());
  }

  addPublication(p: { itemId: string; platform: string; publisher: string; status: Publication["status"]; externalId?: string; mode?: string; scheduledAt?: string; error?: string }): Publication {
    const id = newId("p_");
    this.touch(
      "INSERT INTO publications (id, item_id, platform, publisher, external_id, mode, status, scheduled_at, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id, p.itemId, p.platform, p.publisher, p.externalId ?? null, p.mode ?? null, p.status, p.scheduledAt ?? null, p.error ?? null, this.now(),
    );
    return this.getPublication(id)!;
  }
  getPublication(id: string): Publication | undefined {
    const r = this.db.prepare("SELECT * FROM publications WHERE id = ?").get(id) as Row | undefined;
    return r ? toPublication(r) : undefined;
  }
  updatePublication(id: string, patch: Partial<Pick<Publication, "status" | "externalId" | "mode" | "scheduledAt" | "error">>): void {
    const cur = this.getPublication(id);
    if (!cur) throw new KitError(`Publicação ${id} não encontrada`, "NOT_FOUND");
    const m = { ...cur, ...patch };
    this.touch("UPDATE publications SET status = ?, external_id = ?, mode = ?, scheduled_at = ?, error = ? WHERE id = ?", m.status, m.externalId, m.mode, m.scheduledAt, m.error, id);
  }
  publicationsOf(itemId: string): Publication[] {
    return (this.db.prepare("SELECT * FROM publications WHERE item_id = ? ORDER BY created_at, rowid").all(itemId) as Row[]).map(toPublication);
  }
  /** Publications of a platform created today (profile timezone). Failed ones and cap overflows do not count. */
  publicationsToday(platform: string): number {
    const today = dayKey(this.clock.now(), this.timezone);
    const rows = this.db.prepare("SELECT created_at FROM publications WHERE platform = ? AND status != 'failed' AND error IS NULL").all(platform) as { created_at: string }[];
    return rows.filter((r) => dayKey(new Date(r.created_at), this.timezone) === today).length;
  }
  listPublications(opts: { status?: Publication["status"][]; limit?: number } = {}): Publication[] {
    const sts = opts.status ?? [];
    const where = sts.length ? `WHERE status IN (${placeholders(sts.length)})` : "";
    return (this.db.prepare(`SELECT * FROM publications ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...sts, opts.limit ?? 100) as Row[]).map(toPublication);
  }

  // ------------------------------------------------------------ kv

  kvGet(k: string): string | undefined {
    return (this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined)?.v;
  }
  kvSet(k: string, v: string): void {
    this.touch("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }
  kvDel(k: string): void {
    this.touch("DELETE FROM kv WHERE k = ?", k);
  }

  // ------------------------------------------------------------ LLM usage

  recordUsage(u: { role: string; model: string; inputTokens: number; outputTokens: number; costBRL: number; ok: boolean; error?: string }): void {
    const d = this.clock.now();
    this.touch("INSERT INTO llm_usage (at, month, role, model, input_tokens, output_tokens, cost_brl, ok, error) VALUES (?,?,?,?,?,?,?,?,?)", d.toISOString(), monthKey(d, this.timezone), u.role, u.model, u.inputTokens, u.outputTokens, u.costBRL, u.ok ? 1 : 0, u.error ?? null);
  }
  monthSpendBRL(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(cost_brl), 0) AS s FROM llm_usage WHERE month = ?").get(monthKey(this.clock.now(), this.timezone)) as { s: number }).s;
  }

  // ------------------------------------------------------------ job runs

  startJobRun(job: string): number {
    const r = this.db.prepare("INSERT INTO job_runs (job, started_at) VALUES (?, ?)").run(job, this.now());
    return Number(r.lastInsertRowid);
  }
  finishJobRun(id: number, res: { ok: boolean; summary?: string; error?: string }): void {
    this.touch("UPDATE job_runs SET finished_at = ?, ok = ?, summary = ?, error = ? WHERE id = ?", this.now(), res.ok ? 1 : 0, res.summary ?? null, res.error ?? null, id);
  }
  recentJobRuns(limit = 20): { id: number; job: string; startedAt: string; finishedAt: string | null; ok: boolean | null; summary: string | null; error: string | null }[] {
    return (this.db.prepare("SELECT * FROM job_runs ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      id: r.id as number,
      job: r.job as string,
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string | null) ?? null,
      ok: r.ok === null || r.ok === undefined ? null : r.ok === 1,
      summary: (r.summary as string | null) ?? null,
      error: (r.error as string | null) ?? null,
    }));
  }
}
