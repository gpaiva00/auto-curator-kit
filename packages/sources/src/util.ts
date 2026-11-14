import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { KitError, type SourceConfig } from "@auto-curator/contracts";
import { z } from "zod";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const fold = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

export const clip = (v: string | undefined, max: number): string | undefined => {
  const t = v?.trim();
  return t ? t.slice(0, max) : undefined;
};

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
export const BOT_UA = "Mozilla/5.0 (compatible; auto-curator-kit/0.1)";

/** Canonical form of a URL for dedupe: no hash, no tracking params, no www, no trailing slash, lower-case. */
export function canonicalUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|igsh|igshid|ref$|ref_)/i.test(k)) url.searchParams.delete(k);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return (url.origin + url.pathname.replace(/\/+$/, "") + url.search).toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
}

/** Public web hosts only: no loopback, private, link-local or bare-IP targets (feed and pasted URLs are untrusted input). */
export function isPublicUrl(raw: string, opts: { allowHttp?: boolean } = {}): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (isIP(h.replace(/^\[|\]$/g, ""))) return false;
  return h.includes(".");
}

export const isHttpUrl = (s: string): boolean => /^https?:\/\/\S+$/i.test(s.trim());

export const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

export const isIsoDate = (s: string | undefined): s is string => !!s && !Number.isNaN(Date.parse(s));
export const toIso = (s: string | undefined): string | undefined => (s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : undefined);

/** "1,2 mil", "1.2K", "3,4M", "1.234", "250" -> number. 0 when unknown. */
export function parseCount(raw: string | undefined): number {
  if (!raw) return 0;
  const m = /([\d.,]+)\s*(k|mil|m|mi|milh\S*)?/i.exec(raw.trim());
  if (!m) return 0;
  const unit = (m[2] ?? "").toLowerCase();
  let num = m[1]!;
  if (!unit && /^\d{1,3}(\.\d{3})+$/.test(num)) num = num.replace(/\./g, "");
  else num = num.replace(",", ".");
  const n = parseFloat(num);
  if (!Number.isFinite(n)) return 0;
  if (unit === "k" || unit === "mil") return Math.round(n * 1_000);
  if (unit === "m" || unit === "mi" || unit.startsWith("milh")) return Math.round(n * 1_000_000);
  return Math.round(n);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ options validation (pt-BR messages)

const ptErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case "invalid_type":
      if (issue.received === "undefined") return { message: "campo obrigatório" };
      return { message: `esperado ${tipo(issue.expected)}, recebido ${tipo(issue.received)}` };
    case "invalid_enum_value":
      return { message: `valor inválido; use um de: ${issue.options.join(", ")}` };
    case "invalid_string":
      if (issue.validation === "url") return { message: "URL inválida" };
      return { message: ctx.defaultError };
    case "too_small":
      if (issue.type === "string") return { message: "não pode ser vazio" };
      if (issue.type === "array") return { message: `precisa de pelo menos ${issue.minimum} item(ns)` };
      return { message: `deve ser maior ou igual a ${issue.minimum}` };
    case "too_big":
      return { message: `deve ser menor ou igual a ${issue.maximum}` };
    case "unrecognized_keys":
      return { message: `opção desconhecida: ${issue.keys.join(", ")}` };
    default:
      return { message: ctx.defaultError };
  }
};
const tipo = (t: string): string =>
  ({ string: "texto", number: "número", boolean: "verdadeiro/falso", array: "lista", object: "objeto", undefined: "nada", null: "nulo" })[t] ?? t;

/** The keys every source entry may carry besides its own options. */
export const BASE_KEYS = { type: z.string(), name: z.string().optional(), enabled: z.boolean().optional() };

/** Validates a source entry against its options schema. Throws KitError (pt-BR) naming the type, the source and each bad field. */
export function parseOptions<T extends z.ZodRawShape>(type: string, shape: T, cfg: SourceConfig): z.infer<z.ZodObject<T & typeof BASE_KEYS>> {
  const schema = z.object({ ...BASE_KEYS, ...shape }).strict();
  const r = schema.safeParse(cfg, { errorMap: ptErrorMap });
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => (i.path.length ? `"${i.path.join(".")}": ${i.message}` : i.message));
  const label = cfg.name ? `fonte "${type}" (${cfg.name})` : `fonte "${type}"`;
  throw new KitError(`Configuração inválida na ${label}: ${lines.join("; ")}.`, "SOURCE_CONFIG");
}
