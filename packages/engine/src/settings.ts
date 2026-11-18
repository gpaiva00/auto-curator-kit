import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS, type SettingDef, type SettingView } from "@auto-curator/contracts";
import { loadProfile } from "./config.js";

export class SettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingError";
  }
}

const getAt = (obj: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

function setAt(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

/** The whitelisted settings with their values in the loaded profile (template defaults included). */
export function settingViews(profile: object): SettingView[] {
  return SETTINGS.map((d) => ({ ...d, value: (getAt(profile as Record<string, unknown>, d.path) ?? "padrão") as string | number }));
}

function findDef(key: string): SettingDef {
  const d = SETTINGS.find((s) => s.key === key);
  if (!d) throw new SettingError(`Configuração desconhecida: ${key}`);
  return d;
}

function parseValue(d: SettingDef, raw: string): string | number {
  const v = raw.trim();
  if (d.kind === "text") {
    if (!v) throw new SettingError(`${d.key} não pode ficar vazio.`);
    if (d.path === "timezone") {
      try {
        new Intl.DateTimeFormat("pt-BR", { timeZone: v });
      } catch {
        throw new SettingError(`Fuso horário inválido: ${v} (ex.: America/Sao_Paulo).`);
      }
    }
    return v;
  }
  const n = Number(v.replace(",", "."));
  if (!v || !Number.isFinite(n)) throw new SettingError(`${d.key} precisa ser um número.`);
  if (d.kind === "int" && !Number.isInteger(n)) throw new SettingError(`${d.key} precisa ser um número inteiro.`);
  if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) {
    throw new SettingError(`${d.key} fora do intervalo permitido (${d.min ?? "−∞"} a ${d.max ?? "∞"}).`);
  }
  return n;
}

/**
 * Writes one whitelisted setting into profile.json. The new file is checked by loadProfile; if it does not load,
 * the previous content is restored and the error is thrown. The running app keeps the old config until restart.
 */
export function saveProfileSetting(profileDir: string, key: string, raw: string): SettingView {
  const d = findDef(key);
  const value = parseValue(d, raw);
  const file = join(profileDir, "profile.json");
  const before = readFileSync(file, "utf8");
  const json = JSON.parse(before) as Record<string, unknown>;
  setAt(json, d.path, value);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(json, null, 2) + "\n");
  renameSync(tmp, file);
  try {
    loadProfile(profileDir, {});
  } catch (e) {
    writeFileSync(file, before);
    throw new SettingError(`Não salvo, configuração inválida: ${(e as Error).message}`);
  }
  return { ...d, value };
}
