/**
 * Contador compartilhado de chamadas ao Buffer (SPEC-KIT 7c, item 4).
 *
 * O mesmo arquivo é lido e escrito por todos os processos da máquina que usam a mesma organização:
 * `~/.local/share/buffer-quota/<orgId>.json`, pasta 0700, arquivo 0600. Formato (7c):
 * `{ day: "AAAA-MM-DD" (UTC), calls, bySource: { fonte: n }, rateLimit: { "15m": {r,t}, "24h": ..., "30d": ..., at }, updatedAt }`.
 *
 * Regras: antes de cada requisição HTTP o processo pega o lock atômico (`mkdir <arquivo>.lock`, espera até
 * 2 s, lock com mais de 10 s é considerado morto), relê o arquivo, recusa se `calls >= teto` (padrão 80/dia,
 * `createPost` de item já aprovado pode usar teto + 10) e grava por arquivo temporário + rename.
 * Leitura/gravação com problema conta como orçamento esgotado para LEITURAS; o arquivo nunca é apagado.
 * `recordRateLimit` guarda os cabeçalhos RateLimit e pausa quando alguma janela tem `r <= 2`
 * (ou quando a de 30 dias não cobre a reserva de 10 chamadas por dia até o reset).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Teto diário da organização, somando todos os processos (decisão do dono em 7c). */
export const ORG_DAILY_CALLS_DEFAULT = 80;
/** Folga do `createPost` de um item já aprovado: nunca deixar um post aprovado preso por leituras. */
export const CREATE_RESERVE_CALLS = 10;
/** Reserva mínima por dia na janela de 30 dias. */
export const MIN_DAILY_RESERVE_30D = 10;
export const RATE_WINDOWS = ["15m", "24h", "30d"] as const;
export type RateWindow = (typeof RATE_WINDOWS)[number];

export interface RateLimitWindow {
  /** Chamadas restantes na janela. */
  r: number;
  /** Segundos até a janela reiniciar. */
  t: number;
}

export interface RateLimitSnapshot {
  /** ISO do momento em que os cabeçalhos foram lidos. */
  at: string;
  "15m"?: RateLimitWindow;
  "24h"?: RateLimitWindow;
  "30d"?: RateLimitWindow;
}

export interface LedgerState {
  /** Dia UTC, "AAAA-MM-DD". Dia novo zera `calls` e `bySource`. */
  day: string;
  calls: number;
  bySource: Record<string, number>;
  rateLimit?: RateLimitSnapshot;
  updatedAt: string;
}

export type CallKind = "read" | "create";

export interface LedgerOptions {
  /** Pasta do contador. Padrão `~/.local/share/buffer-quota`; testes passam um diretório temporário. */
  dir?: string;
  /** Relógio injetável (testes). */
  now?: number;
  lockWaitMs?: number;
  lockStaleMs?: number;
}

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const LOCK_POLL_MS = 10;

export const ledgerDir = (): string => path.join(os.homedir(), ".local", "share", "buffer-quota");

/** Caminho do arquivo da organização. O orgId vai para o nome do arquivo, então não aceita separador. */
export function ledgerFile(orgId: string, dir: string = ledgerDir()): string {
  if (!/^[A-Za-z0-9._-]+$/.test(orgId)) throw new Error(`orgId inválido para o contador do Buffer: ${JSON.stringify(orgId)}`);
  return path.join(dir, `${orgId}.json`);
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* já no modo certo, ou pasta de outro dono: não é motivo para falhar */
  }
}

/** Lock atômico por `mkdir`; devolve a função que solta. */
function acquireLock(file: string, opts: LedgerOptions): () => void {
  const lock = `${file}.lock`;
  const wait = opts.lockWaitMs ?? LOCK_WAIT_MS;
  const stale = opts.lockStaleMs ?? LOCK_STALE_MS;
  // Lock é tempo de parede (mtime do diretório), não o `now` lógico do contador.
  const clock = (): number => Date.now();
  const deadline = clock() + wait;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      return () => fs.rmSync(lock, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const st = statOrUndefined(lock);
      if (st && clock() - st.mtimeMs > stale) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (clock() >= deadline) throw new Error("lock do contador do Buffer preso");
      sleep(LOCK_POLL_MS);
    }
  }
}

function statOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

interface ReadResult {
  state?: LedgerState;
  /** Arquivo existe mas não é um contador legível: orçamento tratado como esgotado, arquivo preservado. */
  corrupt: boolean;
}

function isLedger(v: unknown): v is LedgerState {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.day === "string" && typeof s.calls === "number" && Number.isFinite(s.calls) && s.calls >= 0;
}

function readState(file: string): ReadResult {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { corrupt: false };
    return { corrupt: true };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isLedger(parsed) ? { state: parsed, corrupt: false } : { corrupt: true };
  } catch {
    return { corrupt: true };
  }
}

let tmpCounter = 0;

/** Escrita atômica: temporário 0600 na mesma pasta + rename. */
function writeState(file: string, state: LedgerState): void {
  tmpCounter = (tmpCounter + 1) % 1_000_000;
  const tmp = `${file}.${process.pid}.${tmpCounter}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* sem permissão para ajustar modo: o conteúdo já foi gravado */
  }
  fs.renameSync(tmp, file);
}

/** Estado atual da organização (para inspeção/doctor); undefined quando ainda não existe. */
export function readLedger(orgId: string, opts: LedgerOptions = {}): LedgerState | undefined {
  return readState(ledgerFile(orgId, opts.dir)).state;
}

/**
 * Até quando as requisições estão pausadas, em ms; undefined quando não há pausa.
 * `r <= 2` em qualquer janela pausa tudo até o reset dela. A janela de 30 dias também pausa quando
 * `r` não cobre a reserva de 10 chamadas por dia até o reset.
 */
export function pausedUntil(state: LedgerState | undefined, now: number = Date.now()): number | undefined {
  const rl = state?.rateLimit;
  if (!rl) return undefined;
  const at = Date.parse(rl.at);
  const base = Number.isFinite(at) ? at : now;
  let until: number | undefined;
  for (const w of RATE_WINDOWS) {
    const win = rl[w];
    if (!win || !Number.isFinite(win.r) || !Number.isFinite(win.t) || win.t < 0) continue;
    const low = win.r <= 2;
    const thin30d = w === "30d" && win.r > 2 && win.r < (win.t / 86_400) * MIN_DAILY_RESERVE_30D;
    if (!low && !thin30d) continue;
    const reset = base + win.t * 1_000;
    until = Math.max(until ?? 0, reset);
  }
  return until !== undefined && until > now ? until : undefined;
}

export type ReserveResult =
  | { ok: true; calls: number; until?: undefined }
  | { ok: false; reason: "budget" | "paused" | "unreadable"; message: string; until?: number };

export interface ReserveOptions extends LedgerOptions {
  orgId: string;
  /** Nome do processo no `bySource` (ex.: "linkedin-curador", "kit-threads", "esteira"). */
  source: string;
  /** Leituras param no teto; `create` (item já aprovado) pode usar teto + 10. */
  kind?: CallKind;
  /** Teto diário da organização. Padrão 80 (`bufferOrgDailyCalls`). */
  cap?: number;
}

/**
 * Reserva uma chamada antes da requisição HTTP. Devolve ok ou o motivo da recusa.
 * Qualquer problema de lock/leitura/gravação recusa (não agenda às cegas) e preserva o arquivo.
 */
export function reserveCall(o: ReserveOptions): ReserveResult {
  const cap = Number.isFinite(o.cap) && (o.cap as number) > 0 ? (o.cap as number) : ORG_DAILY_CALLS_DEFAULT;
  const now = o.now ?? Date.now();
  const file = ledgerFile(o.orgId, o.dir);
  try {
    ensureDir(path.dirname(file));
    const release = acquireLock(file, o);
    try {
      const { state, corrupt } = readState(file);
      if (corrupt) return { ok: false, reason: "unreadable", message: "contador do Buffer ilegível; não agendei" };
      const day = utcDay(now);
      const sameDay = state?.day === day;
      const calls = sameDay ? state!.calls : 0;
      const bySource = sameDay ? { ...state!.bySource } : {};
      const paused = pausedUntil(state, now);
      if (paused !== undefined) {
        return {
          ok: false,
          reason: "paused",
          until: paused,
          message: `chamadas ao Buffer pausadas até ${new Date(paused).toISOString()} (RateLimit)`,
        };
      }
      const limit = o.kind === "create" ? cap + CREATE_RESERVE_CALLS : cap;
      if (calls >= limit) {
        return { ok: false, reason: "budget", message: `orçamento de chamadas do Buffer esgotado hoje (${calls}/${limit})` };
      }
      const next: LedgerState = {
        day,
        calls: calls + 1,
        bySource: { ...bySource, [o.source]: (bySource[o.source] ?? 0) + 1 },
        ...(state?.rateLimit ? { rateLimit: state.rateLimit } : {}),
        updatedAt: new Date(now).toISOString(),
      };
      writeState(file, next);
      return { ok: true, calls: next.calls };
    } finally {
      release();
    }
  } catch (e) {
    return { ok: false, reason: "unreadable", message: `contador do Buffer indisponível (${(e as Error).message}); não agendei` };
  }
}

/**
 * Parser do cabeçalho `RateLimit`: `"15m"; r=147; t=859, "24h"; r=597; t=86359, "30d"; r=1946; t=1925352`
 * (a doc mostra `"150-in-15min";r=98;t=897`; os dois formatos passam). Devolve undefined quando nada é lido.
 */
export function parseRateLimit(header: string | null | undefined): Partial<Record<RateWindow, RateLimitWindow>> | undefined {
  if (!header) return undefined;
  const out: Partial<Record<RateWindow, RateLimitWindow>> = {};
  for (const part of header.split(",")) {
    const name = part.match(/^\s*"([^"]+)"/)?.[1];
    const r = part.match(/\br\s*=\s*(\d+)/)?.[1];
    const t = part.match(/\bt\s*=\s*(\d+)/)?.[1];
    if (!name || r === undefined || t === undefined) continue;
    const w: RateWindow | undefined = name.includes("15") ? "15m" : name.includes("24") ? "24h" : name.includes("30") ? "30d" : undefined;
    if (!w) continue;
    out[w] = { r: Number(r), t: Number(t) };
  }
  return Object.keys(out).length ? out : undefined;
}

export interface RecordResult {
  /** Os cabeçalhos foram gravados no contador. */
  recorded: boolean;
  /** Pausa resultante (ms), quando alguma janela exige. */
  pausedUntil?: number;
  error?: string;
}

/**
 * Registra os cabeçalhos RateLimit de uma resposta (leitura ou createPost) no arquivo compartilhado.
 * Best effort: falha aqui não derruba o agendamento, só deixa de registrar.
 */
export function recordRateLimit(header: string | null | undefined, o: Omit<ReserveOptions, "kind" | "cap">): RecordResult {
  const parsed = parseRateLimit(header);
  if (!parsed) return { recorded: false };
  const now = o.now ?? Date.now();
  const file = ledgerFile(o.orgId, o.dir);
  try {
    ensureDir(path.dirname(file));
    const release = acquireLock(file, o);
    try {
      const { state, corrupt } = readState(file);
      if (corrupt) return { recorded: false, error: "contador do Buffer ilegível" };
      const day = utcDay(now);
      const sameDay = state?.day === day;
      const next: LedgerState = {
        day,
        calls: sameDay ? state!.calls : 0,
        bySource: sameDay ? { ...state!.bySource } : {},
        rateLimit: { ...parsed, at: new Date(now).toISOString() },
        updatedAt: new Date(now).toISOString(),
      };
      writeState(file, next);
      const paused = pausedUntil(next, now);
      return { recorded: true, ...(paused !== undefined ? { pausedUntil: paused } : {}) };
    } finally {
      release();
    }
  } catch (e) {
    return { recorded: false, error: (e as Error).message };
  }
}
