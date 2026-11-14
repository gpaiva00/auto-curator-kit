# Arquitetura

## 1. Visão geral

O motor é um conjunto de pacotes de workspace (bun). `contracts` define os tipos e as portas; `engine` orquestra; os demais implementam portas. O `cli` monta tudo (`buildRuntime`, em `packages/cli/src/wire.ts`). Nada toca a rede na montagem: rede só entra na leitura das fontes, na IA, no Telegram, no Buffer e no download de mídia.

```text
                 ┌──────────────── cli (comandos, wire, lock) ────────────────┐
                 │                                                            │
 contracts ◄── engine (App, jobs, policy, store, llm, prompts, scheduler)     │
   ▲             ▲          ▲            ▲             ▲                       │
   │             │          │            │             │                       │
 sources       media    publishers    telegram      (LLM via fetch)           │
 (Source)    (Preparer,  (Publisher,   (Notifier,                            │
              Downloader)  MediaHost)   BotActions)                          │
                 └────────────────────────────────────────────────────────────┘
```

As dependências vão sempre para `contracts`. `engine` não importa os pacotes de implementação: recebe as portas por injeção.

## 2. Pacotes

| Pacote | Responsabilidade | Principais arquivos |
|---|---|---|
| `@auto-curator/contracts` | Schemas zod e tipos: `ProfileConfig`, `TemplateConfig`, `ModelsConfig`, `Item` e estados, `Draft`, `RawItem`, portas, erros (`KitError`, `PublishError`), logger e relógio. | `config.ts`, `item.ts`, `draft.ts`, `ports.ts` |
| `@auto-curator/engine` | Carga do perfil (`loadProfile`, merge com o template, `.env`), `Store` (SQLite), `LlmClient`, `FilePromptProvider`, policy (veto, `enforceEditorial`, `queueGate`), jobs (ingest, triage, curate, prepare, present, expire), `App` (implementa `BotActions`), `Scheduler`, fakes para teste. | `config.ts`, `store.ts`, `llm.ts`, `prompts.ts`, `policy.ts`, `jobs.ts`, `app.ts`, `scheduler.ts`, `testing.ts` |
| `@auto-curator/telegram` | `TelegramApi` (HTTP cru do Bot API), `TelegramBot` (long polling, autorização por chat e usuário, roteamento de comandos e callbacks, fluxos de texto), layout das mensagens, teclados, textos. | `api.ts`, `bot.ts`, `commands.ts`, `messages.ts`, `keyboards.ts`, `strings.ts` |
| `@auto-curator/sources` | `registerSource`/`createSource`, fontes embutidas, leitor de feeds e leitor de navegador (CDP) com limitador de ritmo. | `registry.ts`, `rss.ts`, `google-news.ts`, `google-trends.ts`, `manual.ts`, `x-feed.ts`, `instagram-profile.ts`, `browser/cdp.ts` |
| `@auto-curator/media` | Preparadores (`none`, `original`, `render`), download com yt-dlp e limitador, renderização de card (satori + resvg + sharp) e de vídeo (ffmpeg). | `factory.ts`, `preparers/*.ts`, `downloader/*.ts`, `render/*.ts` |
| `@auto-curator/publishers` | Publicador do Buffer (GraphQL: criar post, descobrir canal, listar agendados) e hospedagens de mídia (R2 e imgBB). | `buffer.ts`, `media-hosts.ts` |
| `@auto-curator/cli` | Comandos, parser de argumentos (`node:util` `parseArgs` estrito), resolução de perfil, lock de instância única, `doctor`, `eval` (casamento de casos), `dry-run`. | `main.ts`, `args.ts`, `commands/*.ts`, `wire.ts`, `profile.ts`, `lock.ts` |

Dependências de runtime relevantes: `zod`, `playwright-core` (só para o leitor de navegador), `satori`, `sharp`, `@resvg/resvg-js` e `@fontsource/inter` (render). Banco: `node:sqlite` (embutido no Node 22.5+).

## 3. Máquina de estados do item

Fonte: `packages/contracts/src/item.ts`.

```text
 new ──► scored ──► curated ──► ready ──► pending_approval ──► approved ──► published
  │        │          │          │              │
  └────────┴──────────┴──────────┴─► skipped    ├─► rejected
                                                ├─► curated   (🔁 Refazer: volta para o Curador)
                                                └─► ready     (✏️/🏷 edição: mídia preparada de novo, reenviada)
```

- `new -> curated` é permitido para itens manuais e de perfil (sem triagem).
- `ready` = mídia preparada (render, original ou nenhuma). O próximo passo envia para o Telegram.

Tabela de transições (`TRANSITIONS`):

| De | Para |
|---|---|
| `new` | `scored`, `curated`, `skipped` |
| `scored` | `curated`, `skipped` |
| `curated` | `ready`, `skipped`, `curated` |
| `ready` | `pending_approval`, `skipped`, `curated` |
| `pending_approval` | `approved`, `rejected`, `curated`, `ready` |
| `approved` | `published` |
| `rejected`, `published`, `skipped` | (terminais) |

Toda transição grava uma linha em `transitions` (de, para, nota, instante). `Store.transition` rejeita transições ilegais.

Quem move o quê:

| Evento | Transição |
|---|---|
| Ingestão de feed | (novo) `new`; triagem decide `scored` ou `skipped` |
| `/add`, perfil ou eval | `new` ou direto `curated` com nota 100 |
| Triagem abaixo de `triageMinScore` | `skipped` |
| Curadoria com veredito `skip` | `skipped` |
| Curadoria com `publish` ou `needs_human` | `curated` |
| Mídia pronta | `ready` |
| Enviado ao Telegram | `pending_approval` |
| ✅ Aprovar | `approved` e, se todos os destinos são Buffer, `published` |
| ❌ Rejeitar | `rejected` |
| 🔁 Refazer | `curated` (novo rascunho, reenviado) |
| ✏️ / 🏷 | `ready` (mídia de novo, reenviado) |
| Itens não manuais, não finalizados, mais velhos que `maxItemAgeHours` | `skipped` (expirado) |
| `attempts` ≥ `maxAttempts` após falha de LLM ou de mídia | `skipped` |

Publicação manual: `approved` vira `published` quando todas as publicações manuais recebem ✅ Publiquei.

## 4. Portas

Definidas em `packages/contracts/src/ports.ts`. Cada uma é implementada por um pacote e injetada no `App`.

```ts
interface Source {                       // sources
  readonly type: string;
  readonly name: string;
  fetch(ctx: SourceContext): Promise<RawItem[]>;
  fromInput?(input: string, ctx: SourceContext): Promise<RawItem | undefined>;
}

interface Preparer {                     // media (render | original | none)
  readonly strategy: "render" | "original" | "none";
  prepare(item: Item, draft: Draft, ctx: PrepareContext): Promise<PreparedMedia[]>;
}

interface MediaDownloader {              // media (yt-dlp)
  isAvailable(): Promise<boolean>;
  download(url: string, outDir: string, opts?: { maxDurationSec?: number }): Promise<{ type: "image" | "video"; localPath: string; durationSec?: number }[]>;
}

interface Publisher {                    // publishers (hoje: buffer)
  readonly name: string;
  publish(req: PublishRequest): Promise<PublishResult>;
  listScheduled?(): Promise<{ externalId: string; platform: string; text: string; scheduledAt?: string }[]>;
}

interface MediaHost {                    // publishers (R2, imgBB)
  readonly name: string;
  supports(kind: "image" | "video"): boolean;
  upload(localPath: string): Promise<string>;   // devolve URL pública
}

interface Notifier {                     // engine -> telegram
  sendApproval(item: Item): Promise<number[]>;  // ids das mensagens enviadas
  notify(text: string): Promise<void>;
}

interface BotActions {                   // telegram -> engine (App implementa)
  addManual(input: string): Promise<{ item?: Item; error?: string }>;
  runPipeline(): Promise<void>;
  ingestNow(): Promise<string>;
  regenerate(id: string, feedback?: string): Promise<void>;
  reprepare(id: string): Promise<void>;
  approve(id: string): Promise<DestinationOutcome[]>;
  reject(id: string, reasonCode: string): Promise<void>;
  markPublished(id: string, platform: string): Promise<void>;
  agenda(): Promise<{ platform: string; label: string; scheduledAt?: string }[]>;
  isPaused(): boolean;
  setPaused(p: boolean): void;
  status(): StatusSnapshot;
}

interface StorePort { /* get, list, count, transition, setDraft, recordApproval, kvGet/kvSet/kvDel, monthSpendBRL, presentedToday... */ }
interface LlmPort { json<T>(req: JsonRequest<T>): Promise<{ value: T; costBRL: number; model: string }>; }
interface PromptProvider { get(role: "triage" | "curator"): { text: string; version: string }; }
```

`Logger`, `Clock` e `KitError` também vêm de `ports.ts`. Há implementações de teste (`FakeSource`, `FakeLlm`, `FakePublisher`, `RecordingNotifier`, `StaticPromptProvider`) em `packages/engine/src/testing.ts`, usadas pelo `dry-run`.

Em `buildRuntime`, o bot e o `App` dependem um do outro. A cadeia é quebrada por um `notifier` que delega ao bot depois de criado.

## 5. Banco de dados

Arquivo: `<dataDir>/curator.db` (SQLite em modo WAL, chaves estrangeiras ligadas). Padrão de `dataDir`: `data/<id>/`, ou `CURADOR_DATA_DIR`. As migrações estão em `MIGRATIONS` (`packages/engine/src/store.ts`): são numeradas, aplicadas em transação e nunca editadas depois de aplicadas. Hoje há uma migração (`1: initial`).

| Tabela | Colunas principais | Para que serve |
|---|---|---|
| `_migrations` | `id`, `name`, `applied_at` | Migrações aplicadas. |
| `items` | `id` (`i_` + 12 hex), `dedupe_hash` (UNIQUE), `origin`, `source`, `source_url`, `author`, `title`, `text`, `media_json`, `posted_at`, `captured_at`, `engagement_json`, `extra_json`, `status`, `score` (0–100), `reason`, `draft_json`, `prepared_json`, `telegram_msg_ids`, `attempts`, `priority`, `created_at`, `updated_at` | Uma linha por item. Índices em `status` e `author`. |
| `transitions` | `id`, `item_id`, `from_status`, `to_status`, `note`, `at` | Histórico de cada mudança de estado. |
| `approvals` | `id`, `item_id`, `action`, `reason`, `at` | Decisões humanas: `approve`, `reject` (com código do motivo), `edit_body`, `edit_headline`, `regenerate` (com instrução), `published_manual`. |
| `publications` | `id`, `item_id`, `platform`, `publisher` (`buffer` ou `manual`), `external_id`, `mode`, `status` (`scheduled`, `published`, `failed`, `manual`), `scheduled_at`, `error`, `created_at` | Uma linha por destino de cada aprovação. |
| `llm_usage` | `id`, `at`, `month` (`AAAA-MM` no fuso do perfil), `role`, `model`, `input_tokens`, `output_tokens`, `cost_brl`, `ok`, `error` | Cada chamada à IA, inclusive falhas. Base do teto mensal. |
| `kv` | `k` (PK), `v` | Estado pequeno: `paused` (`"1"` quando pausado); `tg_await` (o que o bot espera do próximo texto, ex.: `body:<id>`); `src:<fonte>:<chave>` (estado de cada fonte); `ig.seen.<usuário>` (posts já lidos de cada perfil do Instagram); `x.limiter` e `ig.limiter` (limitador de ritmo). |
| `job_runs` | `id`, `job` (`ingest` ou `pipeline`), `started_at`, `finished_at`, `ok`, `summary`, `error` | Histórico de execuções (aparece no `status`). |

Consultas úteis para depurar, em um cliente SQLite:

```sql
SELECT status, COUNT(*) FROM items GROUP BY status;
SELECT id, from_status, to_status, note, at FROM transitions WHERE item_id = 'i_...' ORDER BY id;
SELECT month, ROUND(SUM(cost_brl), 4) FROM llm_usage GROUP BY month;
```

## 6. Cliente LLM

Arquivo: `packages/engine/src/llm.ts`. Cliente compatível com OpenAI (`POST <baseUrl>/chat/completions`), usado pelos dois papéis: `triage` (nota em lote) e `curator` (rascunho por item).

### Configuração

`models.json` (ver a seção "models.json (LLM)" em [PERFIL.md](PERFIL.md)): `monthlyBudgetBRL`, `usdBrl`, e para cada papel `baseUrl`, `apiKeyEnv`, `model`, `inputUsdPerM`, `outputUsdPerM`, `maxTokens`, `temperature`, `jsonMode` e `fallback`.

### Cadeia de fallback

1. Tenta o modelo principal do papel.
2. Se falhar com erro que justifica tentar outro, passa para o próximo `fallback`, na ordem. Sem nova tentativa no anterior.
3. Justificam fallback: HTTP 400, 402, 429 e 5xx, erro de rede e timeout, e chave ausente (a chave ausente pula o provedor).
4. **Não** justificam fallback: estouro de orçamento e saída inválida (JSON que não passa no schema).

### Retentativas

- Erros de rede, timeouts (90 s por chamada) e HTTP 5xx ou 429: até 3 novas tentativas, com espera exponencial (1 s, 2 s, 4 s, com até 25% de jitter). `Retry-After` é respeitado, com teto de 60 s.
- 429 com outro modelo disponível na cadeia: não espera, passa direto para o fallback.
- 429 com "tokens per day" (limite diário): falha imediatamente, sem espera.

### Saída estruturada

- Com `jsonMode: true`, pede `response_format: json_object`. A triagem recebe a instrução de devolver `{"items": [...]}` em vez de um array no topo.
- O JSON é extraído (aceita bloco de código) e validado pelo schema do papel.
- Se a validação falhar, há **uma** tentativa de reparo com o erro descrito. Se o reparo também falhar, `LlmOutputError`.

### Orçamento

- Antes de cada chamada, o cliente estima o custo do pior caso: tokens de entrada estimados (caracteres ÷ 3) e `maxTokens` de saída, convertidos com `usdBrl`.
- Se `gasto no mês + estimativa > monthlyBudgetBRL`, a chamada é recusada (`BudgetExceededError`) sem ser feita.
- O gasto do mês é a soma de `llm_usage.cost_brl` no mês corrente, no fuso do perfil.
- Com orçamento esgotado, triagem e curadoria ficam em espera (o `status` mostra o motivo). O 🔁 Refazer não passa por essa espera: a chamada é recusada e o bot responde com o erro de orçamento. O `doctor` avisa a partir de 80% e falha em 100%.
- Cada chamada que chega ao provedor grava uma linha em `llm_usage`, com sucesso ou falha HTTP e de rede. Chamadas recusadas pelo orçamento não são gravadas. O custo real usa o `usage` devolvido pelo provedor; quando ele não vem, usa a estimativa.

### Efeito no pipeline

- Triagem: se o orçamento segura o lote ou a chamada falha por rede, o lote é deixado como está para a próxima execução. Se a saída é inválida, cada item ganha uma falha em `attempts`.
- Curadoria: saída inválida conta como falha de tentativa. Depois de `maxAttempts`, o item vai para `skipped`.

## 7. Execução: jobs, agendador e lock

- `App.ingest()` lê todas as fontes (uma falha não derruba as outras) e grava os novos itens.
- `App.tick()` roda, nesta ordem: expiração → triagem → curadoria → mídia → envio para aprovação. Com o perfil pausado, só a expiração roda; triagem, curadoria, mídia e envio ficam parados.
- O agendador (`createScheduler`) roda `ingest` a cada `intervalsMinutes.ingest` e `pipeline` a cada `intervalsMinutes.pipeline`. Ao subir, roda os dois uma vez. Jobs nunca se sobrepõem, e um job já na fila não entra duas vezes. Cada execução grava em `job_runs`.
- Com o perfil pausado, o agendador pula ingestão e pipeline (registra no log). `/ler` e `/add` seguem funcionando, porque não passam pelo agendador.
- Ações do bot (aprovar, rejeitar, refazer, editar) usam a mesma fila exclusiva do `App`: um passo do pipeline, uma ingestão ou uma ação do humano não rodam ao mesmo tempo.
- `start` mantém `data/<id>/.start.lock` com o pid. Outra instância do mesmo perfil sai com código **75**. Lock de pid morto é reaproveitado.
- SIGINT e SIGTERM param o bot e o agendador, fecham o banco e liberam o lock.
- O bot usa long polling (`getUpdates`); não há porta HTTP de entrada.
