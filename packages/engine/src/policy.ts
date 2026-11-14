import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Draft, EditorialConfig, Item, ModelsConfig, ProfileConfig, StorePort, TemplateConfig, Logger, Verdict } from "@auto-curator/contracts";
import { silentLogger } from "@auto-curator/contracts";
import { ConfigError } from "./config.js";

// ------------------------------------------------------------------ veto (ported from perfil-noticias, flags are free strings)

interface FlagRule {
  flag: string;
  keywords: { raw: string; re: RegExp }[];
  patterns: RegExp[];
  benign: RegExp[];
}

export interface VetoRules {
  /** A hit (or an LLM riskFlag) here forces verdict "skip". */
  vetoFlags: Set<string>;
  /** A hit forces at least "needs_human" and adds the riskFlag. */
  reviewFlags: Set<string>;
  rules: FlagRule[];
  warnings: string[];
}

export interface VetoHit {
  flag: string;
  matched: string;
  hard: boolean;
}

/** lowercase + NFD + strip combining marks (punctuation is kept: some entries contain hyphens/plus signs). */
export const normalizeForVeto = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * veto.json:
 *   { vetoFlags: string[], reviewFlags: string[],
 *     flags: { <flag>: { keywords: string[], patterns: string[] (JS regex, flag u), benign: string[] } } }
 * Matching runs on normalized text, per sentence; a benign pattern in the same sentence cancels the hit for that flag.
 * A flag listed in vetoFlags is a hard veto (skip); in reviewFlags it forces needs_human. A flag with rules but in
 * neither list is a review flag (fail safe).
 */
export function parseVeto(json: unknown): VetoRules {
  const out: VetoRules = { vetoFlags: new Set(), reviewFlags: new Set(), rules: [], warnings: [] };
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    out.warnings.push("veto.json não é um objeto; ignorado");
    return out;
  }
  const o = json as Record<string, unknown>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
  for (const f of strs(o.vetoFlags)) out.vetoFlags.add(f);
  for (const f of strs(o.skipFlags)) out.vetoFlags.add(f);
  for (const f of strs(o.reviewFlags)) if (!out.vetoFlags.has(f)) out.reviewFlags.add(f);

  const compile = (src: string, what: string): RegExp | undefined => {
    try {
      return new RegExp(src, "u");
    } catch {
      out.warnings.push(`regex inválida ignorada (${what}): ${src}`);
      return undefined;
    }
  };
  const flags = (o.flags && typeof o.flags === "object" ? o.flags : {}) as Record<string, { keywords?: unknown; patterns?: unknown; benign?: unknown }>;
  for (const [flag, def] of Object.entries(flags)) {
    if (!out.vetoFlags.has(flag)) out.reviewFlags.add(flag);
    out.rules.push({
      flag,
      keywords: strs(def?.keywords).map((raw) => ({ raw, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(normalizeForVeto(raw))}(?![\\p{L}\\p{N}])`, "u") })),
      patterns: strs(def?.patterns).flatMap((p) => compile(p, flag) ?? []),
      benign: strs(def?.benign).flatMap((p) => compile(p, `${flag}/benign`) ?? []),
    });
  }
  return out;
}

/** Scans text; at most one hit per flag. */
export function scanVeto(text: string, rules: VetoRules): VetoHit[] {
  const sentences = normalizeForVeto(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .filter(Boolean);
  const hits: VetoHit[] = [];
  for (const r of rules.rules) {
    for (const sentence of sentences) {
      const kw = r.keywords.find((k) => k.re.test(sentence));
      const pat = kw ? undefined : r.patterns.find((p) => p.test(sentence));
      if (!kw && !pat) continue;
      if (r.benign.some((b) => b.test(sentence))) continue;
      hits.push({ flag: r.flag, matched: kw ? kw.raw : (pat!.exec(sentence)?.[0] ?? String(pat)), hard: rules.vetoFlags.has(r.flag) });
      break;
    }
  }
  return hits;
}

/** Loads editorial.vetoFile (relative to the profile dir). Undefined when not configured; ConfigError when configured but unreadable. */
export function loadVeto(profileDir: string, editorial: Pick<EditorialConfig, "vetoFile">, logger: Logger = silentLogger): VetoRules | undefined {
  if (!editorial.vetoFile) return undefined;
  const file = isAbsolute(editorial.vetoFile) ? editorial.vetoFile : join(profileDir, editorial.vetoFile);
  if (!existsSync(file)) throw new ConfigError(`vetoFile não encontrado: ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`vetoFile com JSON inválido (${file}): ${(e as Error).message}`);
  }
  const rules = parseVeto(parsed);
  for (const w of rules.warnings) logger.warn(`veto: ${w}`);
  return rules;
}

// ------------------------------------------------------------------ prefilter (no LLM)

/** The first blockedPattern (case-insensitive regex) that matches, or undefined. Invalid regexes are ignored. */
export function matchBlocked(text: string, patterns: string[]): string | undefined {
  for (const p of patterns) {
    try {
      if (new RegExp(p, "i").test(text)) return p;
    } catch {
      /* invalid pattern: ignore */
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ editorial enforcement (after the Curator)

export interface EnforceResult {
  draft: Draft;
  /** pt-BR explanations of what the policy changed. */
  notes: string[];
}

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, Math.max(1, max - 1)).trimEnd() + "…");

/**
 * Applies the profile's editorial rules in code (not in the prompt). Never upgrades a "skip".
 * Order of severity: skip > needs_human > publish.
 */
export function enforceEditorial(draft: Draft, item: Item, profile: ProfileConfig, template: Pick<TemplateConfig, "draftExtraRequired">, opts: { veto?: VetoRules } = {}): EnforceResult {
  const e = profile.editorial;
  const notes: string[] = [];
  let verdict: Verdict = draft.verdict;
  let skipReason = draft.skipReason;
  const riskFlags = [...new Set(draft.riskFlags)];
  const review = (why: string) => {
    notes.push(why);
    if (verdict === "publish") verdict = "needs_human";
  };
  const skip = (why: string) => {
    notes.push(why);
    if (verdict !== "skip") skipReason = why;
    verdict = "skip";
  };

  // 1. veto: text rules and LLM flags
  if (opts.veto) {
    const haystack = [item.title ?? "", item.text, draft.headline, draft.body, ...draft.facts.map((f) => f.claim)].join("\n");
    for (const h of scanVeto(haystack, opts.veto)) {
      if (!riskFlags.includes(h.flag)) riskFlags.push(h.flag);
      if (h.hard) skip(`Veto editorial (${h.flag}): "${h.matched}"`);
      else review(`Revisar: palavra de risco (${h.flag}): "${h.matched}"`);
    }
    for (const f of riskFlags) {
      if (opts.veto.vetoFlags.has(f)) skip(`Veto editorial: flag ${f}`);
      else if (opts.veto.reviewFlags.has(f)) review(`Revisar: flag ${f}`);
    }
  }

  // 2. risk flags
  const skipFlags = riskFlags.filter((f) => e.skip.includes(f));
  if (skipFlags.length) skip(`Descartado por flag: ${skipFlags.join(", ")}`);
  const forced = riskFlags.filter((f) => e.forceReview.includes(f));
  if (forced.length) review(`Revisão obrigatória por flag: ${forced.join(", ")}`);
  const unknown = riskFlags.filter((f) => !e.riskFlags.includes(f) && !e.skip.includes(f) && !e.forceReview.includes(f) && !(opts.veto?.vetoFlags.has(f) || opts.veto?.reviewFlags.has(f)));
  if (unknown.length) review(`Flag desconhecida para este perfil: ${unknown.join(", ")}`);
  if (draft.confidence < e.minConfidence) review(`Confiança baixa (${Math.round(draft.confidence * 100)}% < ${Math.round(e.minConfidence * 100)}%)`);

  // 3. text limits
  const headline = clip(draft.headline.trim(), e.headline.maxChars);
  if (headline !== draft.headline.trim()) notes.push(`Título cortado para ${e.headline.maxChars} caracteres`);
  let body = draft.body.trim();
  if (body.length > e.body.maxChars) {
    body = clip(body, e.body.maxChars);
    notes.push(`Texto cortado para ${e.body.maxChars} caracteres`);
  }
  if (verdict !== "skip" && body.length < e.body.minChars) review(`Texto curto demais (${body.length} < ${e.body.minChars} caracteres)`);

  // 4. hashtags
  let hashtags = [...new Set(draft.hashtags)];
  if (hashtags.length > e.hashtags.max) {
    hashtags = hashtags.slice(0, e.hashtags.max);
    notes.push(`Hashtags reduzidas para ${e.hashtags.max}`);
  }
  if (verdict !== "skip" && hashtags.length < e.hashtags.min) review(`Poucas hashtags (${hashtags.length} < ${e.hashtags.min})`);

  // 5. credit
  let sourceCredit = draft.sourceCredit?.trim() || undefined;
  if (e.credit === "show" && !sourceCredit && verdict !== "skip") {
    const who = item.author.trim() || item.source.trim();
    sourceCredit = `Fonte: ${who}`;
    review(`Crédito da fonte ausente; gerado "${sourceCredit}"`);
  }

  // 6. first comment
  let firstComment = draft.firstComment;
  if (firstComment && !e.firstComment) {
    firstComment = undefined;
    notes.push("Primeiro comentário removido (não permitido neste perfil)");
  }

  // 7. template extras
  const missing = template.draftExtraRequired.filter((k) => draft.extra[k] === undefined || draft.extra[k] === null || draft.extra[k] === "");
  if (missing.length && verdict !== "skip") review(`Campos obrigatórios ausentes em extra: ${missing.join(", ")}`);

  const out: Draft = { ...draft, verdict, skipReason: verdict === "skip" ? (skipReason ?? draft.skipReason ?? "descartado pela política") : draft.skipReason, headline, body, hashtags, sourceCredit, firstComment, riskFlags };
  return { draft: out, notes };
}

/** Appends policy notes to draft.notes (pt-BR, respecting the contract's 1000-char limit). */
export function withNotes(draft: Draft, notes: string[]): Draft {
  if (!notes.length) return draft;
  const joined = [draft.notes.trim(), ...notes.map((n) => `• ${n}`)].filter(Boolean).join("\n");
  return { ...draft, notes: clip(joined, 1000) };
}

// ------------------------------------------------------------------ queue gate

export interface GateArgs {
  store: Pick<StorePort, "count" | "presentedToday" | "monthSpendBRL">;
  profile: ProfileConfig;
  models: Pick<ModelsConfig, "monthlyBudgetBRL">;
  paused: boolean;
  /** "curate": counts work already in flight; "present": counts only what already waits for a decision. */
  stage: "curate" | "present";
  /** Item being considered (its score can bypass the pending cap; manual items bypass pending and daily caps). */
  score?: number | null;
  manual?: boolean;
}

/** Budget only (triage, curate and regenerate all spend LLM money). pt-BR reason or undefined. */
export function budgetGate(store: Pick<StorePort, "monthSpendBRL">, models: Pick<ModelsConfig, "monthlyBudgetBRL">): string | undefined {
  const spent = store.monthSpendBRL();
  if (spent >= models.monthlyBudgetBRL) return `orçamento mensal esgotado (R$ ${spent.toFixed(2)} de R$ ${models.monthlyBudgetBRL.toFixed(2)})`;
  return undefined;
}

/** Returns a pt-BR reason when generation must hold, undefined when it may proceed. */
export function queueGate(a: GateArgs): string | undefined {
  if (a.paused) return "pausado";
  const budget = budgetGate(a.store, a.models);
  if (budget) return budget;
  if (a.manual) return undefined;
  const p = a.profile.pipeline;
  const inFlight = a.stage === "curate" ? a.store.count(["curated", "ready"]) : 0;
  const pending = a.store.count("pending_approval") + inFlight;
  if (pending >= p.maxPendingApproval && !((a.score ?? -1) >= p.urgentBypassScore)) return `${pending} posts aguardando decisão (máximo ${p.maxPendingApproval})`;
  const today = a.store.presentedToday() + inFlight;
  if (today >= p.dailyApprovalCap) return `limite diário de ${p.dailyApprovalCap} posts atingido`;
  return undefined;
}
