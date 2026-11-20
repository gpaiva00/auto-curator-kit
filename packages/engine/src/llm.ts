import type { ZodType } from "zod";
import { KitError, LLM_ROLES, errMsg, silentLogger, type JsonRequest, type LlmPort, type LlmRole, type Logger, type ModelsConfig, type RoleConfig } from "@auto-curator/contracts";
import { sleep as realSleep } from "./util.js";

export class BudgetExceededError extends KitError {
  constructor(readonly spentBRL: number, readonly capBRL: number, readonly projectedBRL: number) {
    super(
      `Orçamento mensal de LLM esgotado: gasto R$${spentBRL.toFixed(4)} + esta chamada (est. R$${projectedBRL.toFixed(4)}) > teto R$${capBRL.toFixed(2)}. Chamada recusada.`,
      "BUDGET_EXCEEDED",
    );
    this.name = "BudgetExceededError";
  }
}
export class LlmHttpError extends KitError {
  constructor(message: string, readonly status: number) {
    super(message, "LLM_HTTP");
    this.name = "LlmHttpError";
  }
}
export class LlmOutputError extends KitError {
  constructor(message: string, readonly raw: string) {
    super(message, "LLM_OUTPUT");
    this.name = "LlmOutputError";
  }
}
export class MissingApiKeyError extends KitError {
  constructor(role: string, envName: string) {
    super(`Chave de API ausente para o papel "${role}": defina ${envName} no .env do perfil`, "MISSING_API_KEY");
    this.name = "MissingApiKeyError";
  }
}

/** What the client needs from the store (the engine Store implements it). */
export interface LlmUsageStore {
  recordUsage(u: { role: string; model: string; inputTokens: number; outputTokens: number; costBRL: number; ok: boolean; error?: string }): void;
  monthSpendBRL(): number;
}

type Msg = { role: "system" | "user" | "assistant"; content: string };

export interface LlmClientDeps {
  models: ModelsConfig;
  store: LlmUsageStore;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: Logger;
  maxRetries?: number;
  backoffBaseMs?: number;
  timeoutMs?: number;
}

/** Rough token estimate, used only for the PRE-call budget projection (real usage is recorded afterwards). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3);

export function costBRL(rc: Pick<RoleConfig, "inputUsdPerM" | "outputUsdPerM">, usdBrl: number, inTok: number, outTok: number): number {
  return ((inTok * rc.inputUsdPerM + outTok * rc.outputUsdPerM) / 1_000_000) * usdBrl;
}

export const ARRAY_WRAP_NOTE =
  '\n\nAPI CONSTRAINT: the response must be a single JSON object. If the output above is a JSON array, return it wrapped exactly as {"items": [ ...the array... ]} and nothing else.';

/** zod preprocess helper: accepts a bare array or an object wrapping one (items/results/triage/...or the only array value). */
export function unwrapArray(v: unknown): unknown {
  if (Array.isArray(v) || !v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  for (const k of ["items", "results", "triage", "entries", "findings"]) if (Array.isArray(o[k])) return o[k];
  const arrays = Object.values(o).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0] : v;
}

export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1]!.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through to slice */
  }
  const starts = [t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) throw new Error("no JSON found in output");
  const s = Math.min(...starts);
  const closer = t[s] === "{" ? "}" : "]";
  const e = t.lastIndexOf(closer);
  if (e <= s) throw new Error("unterminated JSON in output");
  return JSON.parse(t.slice(s, e + 1));
}

/** Errors that justify trying the next model. Budget and bad-output problems never do; a missing key just skips that provider. */
export function isFallbackable(e: unknown): boolean {
  if (e instanceof BudgetExceededError || e instanceof LlmOutputError) return false;
  if (e instanceof MissingApiKeyError) return true;
  if (e instanceof LlmHttpError) return e.status === 400 || e.status === 402 || e.status === 429 || e.status >= 500;
  return true; // network / timeout
}

// ------------------------------------------------------------ cadeia ativa por papel (regra única)

export type ProviderCfg = Omit<RoleConfig, "fallback">;

export interface ActiveProvider {
  cfg: ProviderCfg;
  envName: string;
  /** Nome curto do provedor, pelo host do endpoint (ex.: "groq"). */
  provider: string;
}

export interface RoleChain {
  role: LlmRole;
  /** Providers com chave definida, na ordem de tentativa. O primeiro é o que responde. */
  active: ActiveProvider[];
  /** Providers da cadeia sem chave: saem da cadeia ativa. */
  skipped: ActiveProvider[];
  /** Todas as variáveis aceitas para o papel, sem repetir. */
  acceptedEnvs: string[];
}

const PROVIDER_HOSTS: [RegExp, string][] = [
  [/groq/, "groq"],
  [/openrouter/, "openrouter"],
  [/deepseek/, "deepseek"],
  [/googleapis|gemini/, "gemini"],
  [/openai\.com/, "openai"],
  [/anthropic/, "anthropic"],
];

export function providerLabel(baseUrl: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    // mantém o texto como está
  }
  return PROVIDER_HOSTS.find(([re]) => re.test(host))?.[1] ?? host;
}

/**
 * A ÚNICA regra da cadeia de LLM. Carga, doctor, start e LlmClient usam esta função.
 * Para cada papel: principal + fallbacks, só os cuja variável de chave está definida, na ordem.
 */
export function resolveRoleChain(models: Pick<ModelsConfig, "roles">, env: NodeJS.ProcessEnv): Record<LlmRole, RoleChain> {
  const out = {} as Record<LlmRole, RoleChain>;
  for (const role of LLM_ROLES) {
    const rc = models.roles[role];
    const fb = rc.fallback === undefined ? [] : Array.isArray(rc.fallback) ? rc.fallback : [rc.fallback];
    const all: ActiveProvider[] = [rc, ...fb].map((c) => ({ cfg: c, envName: c.apiKeyEnv, provider: providerLabel(c.baseUrl) }));
    const has = (p: ActiveProvider): boolean => Boolean(env[p.envName]?.trim());
    out[role] = { role, active: all.filter(has), skipped: all.filter((p) => !has(p)), acceptedEnvs: [...new Set(all.map((p) => p.envName))] };
  }
  return out;
}

/** Linha de log da cadeia, sem valores: "triage: ativo openrouter/<modelo>; pulados: groq (GROQ_API_KEY ausente)". */
export function describeChain(c: RoleChain): string {
  const first = c.active[0];
  const parts = [`${c.role}: ${first ? `ativo ${first.provider}/${first.cfg.model}` : "nenhum provider com chave"}`];
  const fallbacks = c.active.slice(1).map((p) => `${p.provider}/${p.cfg.model}`);
  if (fallbacks.length) parts.push(`fallbacks ativos: ${fallbacks.join(", ")}`);
  if (c.skipped.length) parts.push(`pulados: ${c.skipped.map((p) => `${p.provider} (${p.envName} ausente)`).join(", ")}`);
  return parts.join("; ");
}

interface ChatResult {
  content: string;
  model: string;
  cost: number;
}

/** OpenAI-compatible client: fallback chain, monthly BRL cap, JSON mode, one repair retry on invalid JSON. */
export class LlmClient implements LlmPort {
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rnd: () => number;
  private readonly log: Logger;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly d: LlmClientDeps) {
    this.f = d.fetch ?? fetch;
    this.sleep = d.sleep ?? realSleep;
    this.rnd = d.random ?? Math.random;
    this.log = d.logger ?? silentLogger;
    this.env = d.env ?? process.env;
  }

  /** Throws BudgetExceededError if (spent this month + worst-case cost of this call) would pass the cap. */
  assertBudget(messages: Msg[], rc: Pick<RoleConfig, "inputUsdPerM" | "outputUsdPerM" | "maxTokens">): void {
    const inTok = estimateTokens(messages.map((m) => m.content).join("\n"));
    const projected = costBRL(rc, this.d.models.usdBrl, inTok, rc.maxTokens);
    const spent = this.d.store.monthSpendBRL();
    const cap = this.d.models.monthlyBudgetBRL;
    if (spent >= cap || spent + projected > cap) throw new BudgetExceededError(spent, cap, projected);
  }

  async json<T>(req: JsonRequest<T>): Promise<{ value: T; costBRL: number; model: string }> {
    const role = req.role;
    // The triage prompt returns a top-level array, which `json_object` mode rejects: ask for {"items": [...]} (schemas unwrap it).
    const wrap = role === "triage" && this.d.models.roles[role].jsonMode;
    const messages: Msg[] = [
      { role: "system", content: wrap ? req.system + ARRAY_WRAP_NOTE : req.system },
      { role: "user", content: req.user },
    ];
    const first = await this.chat(role, messages, req.label);
    const r1 = this.tryParse(first.content, req.schema);
    if (r1.ok) return { value: r1.value, costBRL: first.cost, model: first.model };

    this.log.warn(`LLM ${role}: saída inválida, tentando um reparo`, r1.error);
    const repair: Msg[] = [
      ...messages,
      { role: "assistant", content: first.content },
      { role: "user", content: `Your previous output was not valid. Problem: ${r1.error}\nReturn ONLY the corrected JSON, no prose, no code fences, following the exact schema and rules from the system message.` },
    ];
    const second = await this.chat(role, repair, req.label ? `${req.label}:repair` : "repair");
    const r2 = this.tryParse(second.content, req.schema);
    if (r2.ok) return { value: r2.value, costBRL: first.cost + second.cost, model: second.model };
    throw new LlmOutputError(`LLM ${role} devolveu JSON inválido após o reparo: ${r2.error}`, second.content);
  }

  private tryParse<T>(text: string, schema: ZodType<T, any, any>): { ok: true; value: T } | { ok: false; error: string } {
    let raw: unknown;
    try {
      raw = extractJson(text);
    } catch (e) {
      return { ok: false, error: `not parseable as JSON (${errMsg(e)})` };
    }
    const r = schema.safeParse(raw);
    if (r.success) return { ok: true, value: r.data };
    return { ok: false, error: r.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }

  /** Primary model first; on 402/429/5xx/network failure (not budget, not bad output) the fallbacks answer, in order. */
  private async chat(role: LlmRole, messages: Msg[], label?: string): Promise<ChatResult> {
    // só providers com chave; nunca se tenta um provider sem chave
    const active = resolveRoleChain(this.d.models, this.env)[role];
    if (!active.active.length) throw new MissingApiKeyError(role, active.acceptedEnvs.join(" ou "));
    // o teto decide quem entra: o principal se couber; senão, o primeiro fallback que couber
    const chain = this.fittingChain(role, messages, active.active.map((p) => p.cfg));
    let lastErr: unknown;
    for (const [i, m] of chain.entries()) {
      try {
        return await this.chatWith(role, m, messages, i === 0 ? label : label ? `${label}:fallback${i}` : `fallback${i}`, i + 1 < chain.length);
      } catch (e) {
        lastErr = e;
        const next = chain[i + 1];
        if (!next || !isFallbackable(e)) throw e;
        this.log.warn(`LLM ${role}: ${m.model} falhou (${errMsg(e).slice(0, 120)}); usando ${next.model}`);
      }
    }
    throw lastErr;
  }

  /**
   * Custo estimado de um provider = entrada estimada pelo tamanho do texto + saída no pior caso (maxTokens do provider),
   * com o preço desse mesmo provider. Só entram providers que cabem no teto restante. Se nenhum couber, BudgetExceededError, sem rede.
   */
  private fittingChain(role: LlmRole, messages: Msg[], candidates: ProviderCfg[]): ProviderCfg[] {
    const spent = this.d.store.monthSpendBRL();
    const cap = this.d.models.monthlyBudgetBRL;
    const inTok = estimateTokens(messages.map((m) => m.content).join("\n"));
    const projected = (rc: ProviderCfg): number => costBRL(rc, this.d.models.usdBrl, inTok, rc.maxTokens);
    const fits = (rc: ProviderCfg): boolean => !(spent >= cap || spent + projected(rc) > cap);
    const fitting = candidates.filter(fits);
    const primary = candidates[0]!;
    if (fitting.length === 0) throw new BudgetExceededError(spent, cap, projected(primary));
    if (!fits(primary)) {
      // log de troca, sem valores de chave
      const next = fitting[0]!;
      this.log.warn(`${role}: principal ${providerLabel(primary.baseUrl)} excede o teto; usando ${providerLabel(next.baseUrl)}/${next.model}`);
    }
    for (const rc of candidates.slice(1)) if (!fits(rc)) this.log.debug(`LLM ${role}: ${providerLabel(rc.baseUrl)} excede o teto; fora desta chamada`);
    return fitting;
  }

  private async chatWith(role: LlmRole, rc: Omit<RoleConfig, "fallback">, messages: Msg[], label?: string, hasNext = false): Promise<ChatResult> {
    const key = this.env[rc.apiKeyEnv];
    if (!key) throw new MissingApiKeyError(role, rc.apiKeyEnv);
    this.assertBudget(messages, rc);

    const url = rc.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const body: Record<string, unknown> = { model: rc.model, messages, temperature: rc.temperature, max_tokens: rc.maxTokens };
    if (rc.jsonMode) body.response_format = { type: "json_object" };

    const maxRetries = this.d.maxRetries ?? 3;
    const base = this.d.backoffBaseMs ?? 1000;
    const fail = (error: string) => this.d.store.recordUsage({ role, model: rc.model, inputTokens: 0, outputTokens: 0, costBRL: 0, ok: false, error });
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.f(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.d.timeoutMs ?? 90_000),
        });
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const text = await res.text().catch(() => "");
          lastErr = new LlmHttpError(`${role} HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
          fail(`HTTP ${res.status}`);
          // a DAILY token cap will not clear in a minute: fail fast so the fallback can answer
          if (res.status === 429 && /tokens per day|\bTPD\b/i.test(text)) throw lastErr;
          // with another model waiting, a 429 is not worth the backoff
          if (res.status === 429 && hasNext) throw lastErr;
          if (attempt === maxRetries) break;
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : base * 2 ** attempt * (1 + this.rnd() * 0.25);
          this.log.warn(`LLM ${role} HTTP ${res.status}, nova tentativa ${attempt + 1}/${maxRetries} em ${Math.round(wait)}ms`);
          await this.sleep(wait);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          fail(`HTTP ${res.status}`);
          throw new LlmHttpError(`${role} HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
        }
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const content = data.choices?.[0]?.message?.content ?? "";
        const inTok = data.usage?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join("\n"));
        const outTok = data.usage?.completion_tokens ?? estimateTokens(content);
        const cost = costBRL(rc, this.d.models.usdBrl, inTok, outTok);
        this.d.store.recordUsage({ role, model: rc.model, inputTokens: inTok, outputTokens: outTok, costBRL: cost, ok: true });
        this.log.debug(`LLM ${role}${label ? " " + label : ""}: ${inTok}+${outTok} tok, R$${cost.toFixed(5)}`);
        return { content, model: rc.model, cost };
      } catch (e) {
        if (e instanceof LlmHttpError || e instanceof BudgetExceededError) throw e;
        lastErr = e; // network/timeout: retry
        fail(errMsg(e).slice(0, 200));
        if (attempt === maxRetries) break;
        const wait = base * 2 ** attempt * (1 + this.rnd() * 0.25);
        this.log.warn(`LLM ${role} erro de rede (${errMsg(e)}), nova tentativa ${attempt + 1}/${maxRetries} em ${Math.round(wait)}ms`);
        await this.sleep(wait);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
