/**
 * Proteção da capacidade do Buffer (SPEC-KIT 7c): fila do canal, limite do plano Free e a decisão pura.
 * Porte literal de ~/Projetos/esteira-produtos/bin/buffer.mjs (a lógica e as mensagens não mudam; a única
 * diferença permitida em 7c é a frase de ação, parametrizada por `capacityCheck({ ..., action })`).
 *
 * Nada aqui faz rede sozinho: o `gqlFn` é injetado pelo chamador (uma chave só, a da organização).
 */

/** Envelope mínimo de uma chamada GraphQL: a query e a chave (o kit usa uma chave por processo). */
export type GqlFn = (query: string, key: string) => Promise<unknown>;

export interface QueueInfo {
  /** Maior dueAt (ms) da fila do canal, ou 0 quando vazia. */
  lastDue: number;
  /** Posts agendados/enviando no canal. */
  count: number;
  /** Próximo dueAt (ms) a sair, ou 0 quando vazia. */
  earliestDueAt: number;
}

export interface QueueChannel {
  id: string;
  orgId: string;
  key: string;
}

/** Plano Free do Buffer: 10 posts agendados por canal. Padrão quando o limite não pode ser lido. */
export const DEFAULT_SCHEDULED_LIMIT = 10;
/** 50 x 100 posts agendados no canal; acima disso, para e não adivinha. */
export const MAX_PAGES = 50;
export const QUEUE_READ_ERR =
  "Não consegui consultar a fila do Buffer; não agendei para não repetir um horário. Tente de novo em instantes.";
/** Frase de ação do kit (7c). */
export const KIT_CAPACITY_ACTION = "Fica aprovado e sai sozinho quando abrir vaga.";
/** Frase de ação da esteira, mantida para o porte literal das mensagens. */
export const ESTEIRA_CAPACITY_ACTION = "Toque de novo quando um post sair.";

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const postsQuery = (orgId: string, channelId: string, after: string | null): string =>
  `query { posts(input: { organizationId: ${JSON.stringify(orgId)}, filter: { channelIds: [${JSON.stringify(channelId)}], status: [scheduled, sending] }, sort: [{ field: dueAt, direction: desc }] }, first: 100${after ? `, after: ${JSON.stringify(after)}` : ""}) { edges { node { dueAt } } pageInfo { hasNextPage endCursor } } }`;

/**
 * Uma leitura paginada da fila deste canal (status scheduled ou sending): maior dueAt, contagem e o próximo a sair.
 * Qualquer falha lança erro: quem chama não deve adivinhar.
 */
export async function bufferQueueInfo(orgId: string, channelId: string, key: string, gqlFn: GqlFn): Promise<QueueInfo> {
  let after: string | null = null;
  let max = 0;
  let min = 0;
  let count = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const d = asRecord(await gqlFn(postsQuery(orgId, channelId, after), key));
    const p = asRecord(d?.posts);
    const pi = asRecord(p?.pageInfo);
    const edges = p?.edges;
    if (!p || !Array.isArray(edges) || !pi || typeof pi.hasNextPage !== "boolean") {
      throw new Error("resposta inesperada do Buffer");
    }
    for (const e of edges) {
      const ms = Date.parse(String(asRecord(asRecord(e)?.node)?.dueAt));
      if (!Number.isFinite(ms)) throw new Error("dueAt inválido do Buffer");
      max = Math.max(max, ms);
      min = min ? Math.min(min, ms) : ms;
      count++;
    }
    if (!pi.hasNextPage) return { lastDue: max, count, earliestDueAt: min };
    if (typeof pi.endCursor !== "string" || !pi.endCursor) throw new Error("paginação sem cursor");
    after = pi.endCursor;
  }
  throw new Error("fila grande demais para ler");
}

/** Só o maior dueAt (contrato antigo). */
export async function bufferLastDue(orgId: string, channelId: string, key: string, gqlFn: GqlFn): Promise<number> {
  return (await bufferQueueInfo(orgId, channelId, key, gqlFn)).lastDue;
}

/** Limite de posts agendados da organização. Devolve null se não der para ler (quem chama usa o padrão). */
export async function readScheduledLimit(orgId: string, key: string, gqlFn: GqlFn): Promise<number | null> {
  const d = asRecord(await gqlFn("query { account { organizations { id limits { scheduledPosts } } } }", key));
  const orgs = asRecord(d?.account)?.organizations;
  const org = Array.isArray(orgs) ? orgs.map(asRecord).find((o) => o?.id === orgId) : undefined;
  const n = asRecord(asRecord(org?.limits))?.scheduledPosts;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** Formata só a data recebida, em America/Sao_Paulo (Brasília). Sem Date.now aqui dentro. */
const slotText = (ms: number): string => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month} às ${p.hour}:${p.minute}`;
};

export interface CapacityCheckInput {
  count: number;
  limit: number | null | undefined;
  earliestDueAt?: number;
  /** Só serve para não anunciar uma vaga que já passou. Sem `now`, a data lida da fila é mostrada assim mesmo. */
  now?: number;
  /** Frase de ação; no kit, `KIT_CAPACITY_ACTION`. */
  action?: string;
}

export interface CapacityVerdict {
  ok: boolean;
  message: string;
}

/**
 * Função pura: a fila do canal está cheia? Devolve { ok, message }.
 * No limite, a mensagem da esteira + " Próxima vaga: DD/MM às HH:MM (Brasília)." quando a vaga é futura.
 */
export function capacityCheck({
  count,
  limit,
  earliestDueAt = 0,
  now,
  action = KIT_CAPACITY_ACTION,
}: CapacityCheckInput): CapacityVerdict {
  const cap = Number.isFinite(limit) && (limit as number) > 0 ? (limit as number) : DEFAULT_SCHEDULED_LIMIT;
  const used = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (used < cap) return { ok: true, message: "" };
  const future = earliestDueAt > 0 && (!Number.isFinite(now) || earliestDueAt > (now as number));
  const next = future ? ` Próxima vaga: ${slotText(earliestDueAt)} (Brasília).` : "";
  return { ok: false, message: `Fila do Buffer cheia: ${used} de ${cap} agendados. ${action}${next}` };
}

/**
 * Leitura da fila para agendar: falha vira o erro em português (7c: nunca adivinha, nunca agenda).
 * O chamador traduz isso em item `queued` com error = "fila ilegível".
 */
export async function readQueueOrThrow(ch: QueueChannel, gqlFn: GqlFn): Promise<QueueInfo> {
  try {
    return await bufferQueueInfo(ch.orgId, ch.id, ch.key, gqlFn);
  } catch {
    throw new Error(QUEUE_READ_ERR);
  }
}
