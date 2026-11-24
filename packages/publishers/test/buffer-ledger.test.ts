import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREATE_RESERVE_CALLS,
  ORG_DAILY_CALLS_DEFAULT,
  ledgerFile,
  parseRateLimit,
  pausedUntil,
  readLedger,
  recordRateLimit,
  reserveCall,
} from "../src/buffer-ledger.js";

const HEADER = '"15m"; r=147; t=859, "24h"; r=597; t=86359, "30d"; r=1946; t=1925352';
const DAY1 = Date.parse("2026-11-21T12:00:00Z");
const DAY2 = Date.parse("2026-11-22T09:00:00Z");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "buffer-quota-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = (orgId = "orgB") => ledgerFile(orgId, dir);
const reserve = (o: Partial<Parameters<typeof reserveCall>[0]> = {}) =>
  reserveCall({ orgId: "orgB", source: "kit-threads", dir, now: DAY1, ...o });

describe("layout do contador", () => {
  it("arquivo por organização, com orgId validado", () => {
    expect(file()).toBe(path.join(dir, "orgB.json"));
    expect(() => ledgerFile("../etc", dir)).toThrow(/orgId inválido/);
    expect(() => ledgerFile("a/b", dir)).toThrow(/orgId inválido/);
    expect(ORG_DAILY_CALLS_DEFAULT).toBe(80);
  });

  it("pasta 0700, arquivo 0600 e nada de temporário sobrando", () => {
    expect(reserve()).toMatchObject({ ok: true, calls: 1 });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["orgB.json"]);
  });

  it("grava o formato da 7c: day UTC, calls, bySource, updatedAt", () => {
    reserve();
    reserve({ source: "linkedin-curador" });
    expect(readLedger("orgB", { dir })).toMatchObject({
      day: "2026-11-21",
      calls: 2,
      bySource: { "kit-threads": 1, "linkedin-curador": 1 },
      updatedAt: new Date(DAY1).toISOString(),
    });
  });
});

describe("teto diário", () => {
  it("recusa no teto (padrão 80) sem criar nada além", () => {
    for (let i = 0; i < 3; i++) expect(reserve({ cap: 3 }).ok).toBe(true);
    const r = reserve({ cap: 3 });
    expect(r).toMatchObject({ ok: false, reason: "budget" });
    expect(readLedger("orgB", { dir })?.calls).toBe(3);
  });

  it("createPost de item aprovado pode usar teto + 10; leitura para no teto", () => {
    for (let i = 0; i < 3; i++) reserve({ cap: 3 });
    expect(reserve({ cap: 3 }).ok).toBe(false);
    for (let i = 0; i < CREATE_RESERVE_CALLS; i++) expect(reserve({ cap: 3, kind: "create" }).ok).toBe(true);
    expect(reserve({ cap: 3, kind: "create" }).ok).toBe(false);
    expect(readLedger("orgB", { dir })?.calls).toBe(3 + CREATE_RESERVE_CALLS);
  });

  it("dia novo UTC zera calls e bySource e mantém o rateLimit", () => {
    reserve({ cap: 1 });
    recordRateLimit(HEADER, { orgId: "orgB", source: "kit-threads", dir, now: DAY1 });
    expect(reserve({ cap: 1, now: DAY2 })).toMatchObject({ ok: true, calls: 1 });
    const s = readLedger("orgB", { dir });
    expect(s).toMatchObject({ day: "2026-11-22", calls: 1, bySource: { "kit-threads": 1 } });
    expect(s?.rateLimit?.["30d"]).toEqual({ r: 1946, t: 1925352 });
  });
});

describe("lock e preservação do arquivo", () => {
  it("lock vivo faz a reserva recusar (não agenda às cegas) e o arquivo continua legível", () => {
    reserve();
    fs.mkdirSync(`${file()}.lock`);
    const r = reserve({ lockWaitMs: 40 });
    expect(r).toMatchObject({ ok: false, reason: "unreadable" });
    expect(readLedger("orgB", { dir })?.calls).toBe(1);
  });

  it("lock com mais de 10 s é considerado morto e removido", () => {
    fs.mkdirSync(`${file()}.lock`);
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(`${file()}.lock`, old, old);
    expect(reserve({ lockStaleMs: 10_000 }).ok).toBe(true);
    expect(fs.existsSync(`${file()}.lock`)).toBe(false);
  });

  it("JSON inválido conta como orçamento esgotado e o arquivo não é apagado", () => {
    fs.writeFileSync(file(), "{ nada");
    expect(reserve()).toMatchObject({ ok: false, reason: "unreadable" });
    expect(fs.readFileSync(file(), "utf8")).toBe("{ nada");
    expect(recordRateLimit(HEADER, { orgId: "orgB", source: "kit-threads", dir, now: DAY1 })).toMatchObject({
      recorded: false,
    });
  });
});

describe("RateLimit", () => {
  it("lê os dois formatos de cabeçalho", () => {
    expect(parseRateLimit(HEADER)).toEqual({ "15m": { r: 147, t: 859 }, "24h": { r: 597, t: 86359 }, "30d": { r: 1946, t: 1925352 } });
    expect(parseRateLimit('"150-in-15min";r=98;t=897')).toEqual({ "15m": { r: 98, t: 897 } });
    expect(parseRateLimit('"15m"; zap=1')).toBeUndefined();
    expect(parseRateLimit(undefined)).toBeUndefined();
  });

  it("registra os três janelas com at", () => {
    expect(recordRateLimit(HEADER, { orgId: "orgB", source: "kit-threads", dir, now: DAY1 })).toMatchObject({ recorded: true });
    const rl = readLedger("orgB", { dir })?.rateLimit;
    expect(rl?.at).toBe(new Date(DAY1).toISOString());
    expect(rl?.["15m"]).toEqual({ r: 147, t: 859 });
  });

  it("r <= 2 em qualquer janela pausa até o reset dela e a reserva recusa", () => {
    const low24 = '"15m"; r=100; t=859, "24h"; r=2; t=86359, "30d"; r=1900; t=1925352';
    const r = recordRateLimit(low24, { orgId: "orgB", source: "kit-threads", dir, now: DAY1 });
    expect(r.pausedUntil).toBe(DAY1 + 86_359_000);
    expect(pausedUntil(readLedger("orgB", { dir }), DAY1)).toBe(DAY1 + 86_359_000);
    expect(reserve()).toMatchObject({ ok: false, reason: "paused", until: DAY1 + 86_359_000 });
    expect(readLedger("orgB", { dir })?.calls).toBe(0);
  });

  it("janela de 30 dias com reserva insuficiente (r < dias restantes x 10) também pausa", () => {
    const thin = '"30d"; r=200; t=864000';
    expect(recordRateLimit(thin, { orgId: "orgB", source: "kit-threads", dir, now: DAY1 }).pausedUntil).toBeUndefined();
    const thin2 = '"30d"; r=50; t=864000';
    expect(recordRateLimit(thin2, { orgId: "orgB", source: "kit-threads", dir, now: DAY1 }).pausedUntil).toBe(DAY1 + 864_000_000);
  });

  it("pausa expirada não bloqueia mais", () => {
    recordRateLimit('"24h"; r=1; t=100', { orgId: "orgB", source: "kit-threads", dir, now: DAY1 });
    expect(reserve({ now: DAY1 + 101_000 })).toMatchObject({ ok: true, calls: 1 });
  });

  it("organizações diferentes têm arquivos diferentes", () => {
    reserve({ orgId: "orgB" });
    reserve({ orgId: "orgC" });
    expect(readLedger("orgB", { dir })?.calls).toBe(1);
    expect(readLedger("orgC", { dir })?.calls).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(["orgB.json", "orgC.json"]);
  });
});
