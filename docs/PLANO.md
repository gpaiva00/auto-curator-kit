Status: fases 0, 1, 2 (perfil linkedin-exemplo) e 4 (perfil astronomia) implementadas; fase 3 (migração dos dados do perfil-noticias) pendente.

# Plano: `auto-curator-kit` — um motor para perfis curados por IA com aprovação no Telegram

Rascunho de 2026-11-14, a partir de `perfil-noticias` (~14 mil linhas TS, 338 testes) e `linkedin-curador` (~2,9 mil linhas, 33 testes).
Nome `auto-curator-kit` é provisório.

---

## 1. Diagnóstico

### 1.1 O pipeline é o mesmo nos dois

```
Fonte(s) → Pré-filtro (regras, sem IA) → Triagem (IA barata) → Curador (IA melhor)
        → Mídia/Render → Aprovação no Telegram → Publicação (Buffer ou manual) → (métricas)
```

Em ambos: SQLite nativo do Node, máquina de estados com log de transições, cliente LLM
OpenAI-compatível com fallback e teto mensal em R$, prompts em `agents/*.md` com versão no cabeçalho,
bot do Telegram por long polling restrito a chat ids, `/add` manual, pausa, Chrome dedicado via CDP para ler a rede social.

### 1.2 O que foi copiado e colado (candidato direto a pacote)

| Peça | perfil-noticias | linkedin-curador | Situação |
|---|---|---|---|
| Cliente LLM + teto de gasto | `core/src/llm.ts` | `src/llm.ts` | ~95% idêntico (só muda o nome da classe de erro) |
| `TelegramApi` (fetch, sem deps) | `core/src/telegram.ts` | `src/telegram.ts` | mesma ideia, assinaturas diferentes |
| Loader de prompts | `core/src/agents.ts` | `src/agents.ts` | mesmo `FilePromptProvider` |
| `chrome-reader.sh` | `downloader/scripts/` | `scripts/` | mesmo script, porta 9222 vs 9333 |
| Cliente Buffer (GraphQL `createPost`) | `publish/buffer.ts` | `src/buffer.ts` | **reescrito duas vezes**, com interfaces diferentes |
| `models.json`, `kv`, `llm_usage`, offset do Telegram | — | — | iguais |

### 1.3 Onde divergiu (e por que você teve de mexer no motor para fazer o LinkedIn)

A causa é uma só: **o nicho e a plataforma de destino estão misturados com o motor.**
O `perfil-noticias` já tem boas abstrações (`FindingSource`, `PublishProvider`, `MediaHost`, `Renderer` como plugin),
mas o *formato do post* e a *interface do Telegram* ficaram presos ao caso de notícias.

| Assunto | perfil-noticias | linkedin-curador |
|---|---|---|
| Modelo de dados | `findings` + `posts` + `publications` + 6 outras tabelas, com migrações | uma tabela `items` |
| Estados | `new/skipped/curated` + `rendered/pending_approval/approved/rejected/published` | `new/scored/curated/pending_approval/approved/rejected/published/skipped` |
| Saída do Curador | `CuratedPost`: `caption`, `categoryTag`, `sourceCredit`, `facts[]`, `format`, `mediaPlan`, `urgency` | `Curated`: `body`, `firstComment`, `notes` |
| Risk flags | `health, minor, death, …` (fofoca) | `confidential, controversial, attack, …` (carreira) |
| Fontes | interface `FindingSource` (RSS, Trends, perfis IG, manual) | leitor do X chamado direto no `jobs.ts`, sem interface |
| Mídia | render próprio (card PNG / vídeo com faixa) | mídia original do post, sem render |
| Publicação | `PublishProvider` + `MediaHost` (R2/imgbb) + slots | `Publisher.publish(item)` só texto |
| Persona/nicho | **dentro de `curator.md`** (regra 1c "niche gate") | separado em `style-guide.md` (melhor) |
| Regras de veto | `veto.json` (normalizado, hard/soft) | `blockedPatterns` (regex) no `pipeline.json` |
| Prefixo de env | `PERFIL_*` | `LKD_*` |

### 1.4 Telegram: o mesmo bot com cara diferente

| | perfil-noticias | linkedin-curador |
|---|---|---|
| Botões | `Aprovar` `Rejeitar` `Editar titulo` `Editar legenda` (sem emoji) | `✅ Aprovar` `❌ Rejeitar` `✏️ Editar texto` `🏷 Editar título` `🔁 Refazer` |
| Callback | `a\|id`, `rj\|id\|motivo` | `ok:id`, `no:id` |
| Rejeitar | pede motivo (8 botões, gravado no banco) | sem motivo |
| Comandos | inglês: `/pause`, `/resume`, `/help`, `/cancel` | português: `/pausar`, `/retomar`, `/ajuda`, `/ler` |
| `/fila` | fila de agendamentos do Buffer | itens em andamento por status (`/pendentes` faz isso no outro) |
| Chats | vários (broadcast) | um só |
| Layout | `messages.ts` com `block()`/`bullets()` e um cabeçalho padrão | texto montado à mão |
| Texto do `/ajuda` | menciona Instagram | menciona X e LinkedIn (hardcoded) |

Ou seja: o mesmo comando muda de nome e de significado entre os projetos. É isso que o pacote precisa fixar.

---

## 2. Proposta: motor + "pacote de perfil"

Regra de ouro: **criar um perfil novo não pode exigir editar código do motor.**
Tudo que muda de um perfil para outro vira configuração, prompt ou plugin.

```
auto-curator-kit/                        (monorepo, bun workspaces)
  packages/
    engine/        Store (SQLite + migrações), máquina de estados, scheduler, gates (caps, cooldown, fila),
                   jobs (ingest → triage → curate → prepare → approve → publish → metrics), LLM + orçamento,
                   loader de prompts, policy/veto, logger, healthcheck
    telegram/      UI de aprovação padrão: layout, botões, comandos, edição, refazer, motivos de rejeição
    sources/       rss · google-news · google-trends · manual · x-feed (browser) · instagram-profile (browser)
    media/         downloader (yt-dlp, limiter) · render (card/vídeo, opcional) · passthrough (mídia original)
    publishers/    buffer (um cliente só, multi-canal, draft/queue/now) · manual (copiar e colar)
    cli/           auto-curator create (scaffold), doctor, scan, dry-run, eval, start
  templates/
    news-card/          herdado do perfil-noticias (fofoca, card + vídeo, Instagram/TikTok)
    thought-leader/     herdado do linkedin-curador (texto + mídia original, LinkedIn)
  profiles/             (fora do repo público, ou exemplos)
    noticias-exemplo/   linkedin-exemplo/   astronomia/
```

### 2.1 Um perfil é uma pasta

```
profiles/astronomia/
  profile.json        identidade, fontes, destinos, limites, política editorial
  style-guide.md      voz, público, assuntos sim/não (lido pelo Curador a cada execução)
  prompts/            opcionais: sobrescrevem triage.md / curator.md do template
  veto.json           opcional
  brand/              logo, cores, fontes (só se usar render)
  evals/              casos de regressão do Curador
  .env                segredos deste perfil
```

`profile.json` (exemplo):

```jsonc
{
  "id": "astronomia",
  "name": "Céu de Hoje",
  "template": "news-card",                 // herda prompts, render e defaults
  "language": "pt-BR",
  "timezone": "America/Sao_Paulo",

  "sources": [
    { "type": "rss", "name": "NASA", "url": "https://www.nasa.gov/feed/" },
    { "type": "rss", "name": "ESA", "url": "https://www.esa.int/rssfeed/Our_Activities/Space_Science" },
    { "type": "google-news", "query": "\"James Webb\" OR eclipse OR cometa" },
    { "type": "manual" }
  ],

  "destinations": [
    { "platform": "instagram", "publisher": "buffer", "mode": "draft", "dailyCap": 4 }
  ],

  "media": { "strategy": "render", "template": "card" },   // render | original | none

  "editorial": {
    "credit": "show",                       // show (notícias) | hide (autoridade/LinkedIn)
    "riskFlags": ["unverified", "outdated", "pseudoscience"],
    "forceReview": ["unverified", "pseudoscience"],
    "skip": [],
    "body": { "maxChars": 2000 },
    "hashtags": { "min": 3, "max": 6 },
    "firstComment": false
  },

  "pipeline": {
    "intervalsMinutes": { "ingest": 30, "pipeline": 5 },
    "triageMinScore": 60,
    "minConfidence": 0.6,
    "maxPendingApproval": 5,
    "dailyApprovalCap": 6,
    "subjectCooldownHours": 4
  },

  "telegram": {
    "rejectReasons": "default"              // ou lista própria
  },

  "budget": { "monthlyBRL": 60, "models": "default" }
}
```

### 2.2 Contrato único do post (`Draft`)

Um formato que serve aos dois casos; o que é específico do nicho fica em `extra`:

```ts
Draft = {
  verdict: "publish" | "needs_human" | "skip",
  skipReason?: string,
  headline: string,            // título curto: rótulo no Telegram e manchete do card
  body: string,                // texto como será publicado (caption no IG, post no LinkedIn)
  hashtags: string[],
  sourceCredit?: string,       // obrigatório se editorial.credit = "show"
  firstComment?: string,
  facts: { claim, sourceUrl }[],
  riskFlags: string[],         // validado contra editorial.riskFlags do perfil
  confidence: number,
  notes: string,               // dúvidas para o humano
  extra: Record<string, unknown>  // categoryTag, mediaPlan, urgency… (o template define o schema)
}
```

O motor valida a parte comum; o template estende com Zod (`news-card` exige `categoryTag` e `mediaPlan`).
Regras de flag → `needs_human`/`skip` saem do prompt e vão para o código (`policy`), lidas do `profile.json`.

### 2.3 Um só modelo de dados

Uma tabela `items` (como no linkedin-curador), com colunas para render e publicação, mais `transitions`,
`approvals` (com motivo), `publications`, `llm_usage`, `kv`, `job_runs`, `metrics`. Estados fixos:

```
new → scored → curated → ready → pending_approval → approved → published
  ↘ skipped     ↘ skipped                 ↘ rejected     ↘ (edit/refazer) → curated
```

`ready` = mídia pronta (render ou original). `scored` é pulado para itens manuais e de perfis seguidos.

### 2.4 Telegram padronizado (o mesmo em todo perfil)

Mensagem de aprovação, sempre nesta ordem (layout `block()` do perfil-noticias):

```
[mídia: render ou original, 1..n]

⚠️ Revisar · p_ab12 · Título do post            (ou 🆕 Novo)
📊 Confiança 82% · 🎯 Instagram · 🛡 Riscos: unverified
❓ Dúvida: …                                     (só se houver)
🔗 Fonte: https://…   ✍️ Crédito: …              (crédito só se credit=show)
─────────
<texto final exatamente como será publicado>

[✅ Aprovar] [❌ Rejeitar]
[✏️ Editar texto] [🏷 Editar título]
[🔁 Refazer]
```

- **Rejeitar** abre os motivos (lista padrão do perfil-noticias, sobrescrevível) e grava em `approvals`.
- **Refazer** pede instrução (`/igual` = tentar de novo), do linkedin-curador.
- **Aprovar** → publisher do destino. Buffer: avisa "rascunho/fila/agendado para 09/11 às 13:15".
  Manual: mídia final + texto + botões `Abrir <plataforma>` e `✅ Publiquei`.
- Callback único: `ação|id[|arg]` (≤ 64 bytes).
- Multi-chat (broadcast) sempre disponível; com um chat só, é igual.

Comandos fixos em pt-BR, com aliases em inglês:

| Comando | Faz |
|---|---|
| `/add <link ou texto>` | cria um item agora (colar só o link também funciona) |
| `/ler` | roda as fontes agora |
| `/pendentes` | o que espera sua aprovação |
| `/fila` | tudo em andamento, agrupado por status |
| `/agenda` | o que está agendado no Buffer |
| `/furar <id>` · `/desfurar <id>` | prioridade |
| `/status` | contagens, gasto de IA, limites, pausa |
| `/pausar` · `/retomar` · `/cancelar` · `/ajuda` | |

Textos do bot ficam em `packages/telegram/strings.pt-BR.ts`; o nome do perfil e das plataformas vêm do `profile.json`.
Testes de snapshot das mensagens garantem que nenhum perfil quebra o formato.

### 2.5 Interfaces de plugin

```ts
interface Source     { name; kind: "feed" | "profile" | "manual"; fetch(ctx): Promise<RawItem[]> }
interface Preparer   { prepare(item, draft): Promise<MediaOut[]> }      // render | original | none
interface Publisher  { name; publish(req): Promise<{ externalId; mode; at? }> }
interface MediaHost  { supports(kind); upload(path): Promise<string> }
interface Notifier   { sendApproval(item); notify(text) }               // Telegram hoje; Slack/Discord depois
```

Fonte nova (Bluesky, Reddit, YouTube, arXiv) = um arquivo em `sources/`, registrado por `type`.

### 2.6 Variáveis de ambiente padronizadas

```
CURADOR_PROFILE=profiles/astronomia
CURADOR_DATA_DIR=data/astronomia          # banco, renders, logs por perfil
TELEGRAM_BOT_TOKEN=                       # um bot por perfil
TELEGRAM_ALLOWED_CHAT_IDS=123,456
GROQ_API_KEY= DEEPSEEK_API_KEY= GEMINI_API_KEY= OPENROUTER_API_KEY=
BUFFER_API_KEY=
BUFFER_CHANNEL_INSTAGRAM= BUFFER_CHANNEL_TIKTOK= BUFFER_CHANNEL_LINKEDIN=
BROWSER_CDP_URL=http://127.0.0.1:9222     # só para fontes de navegador
LOG_LEVEL=info
```

Um processo por perfil (isola bot, banco e orçamento). Dá para rodar vários no mesmo Mac com um plist cada.

### 2.7 Criar um perfil novo

```bash
bunx auto-curator create astronomia --template news-card
# edita profiles/astronomia/profile.json e style-guide.md, cria o bot no @BotFather, preenche .env
bun run doctor --profile astronomia      # ✅/❌ config, chaves, bot, Chrome, Buffer
bun run scan --profile astronomia        # lê as fontes uma vez, sem IA
bun run eval --profile astronomia        # roda os casos do Curador no modelo real
bun run start --profile astronomia
```

---

## 3. O melhor de cada projeto

**Do perfil-noticias:** `FindingSource`, policy/veto em código, gate de fila (`minApprovedToGenerate`, `urgentBypassScore`),
motivos de rejeição, layout `messages.ts`, broadcast, migrações, log de transições, evals do Curador, métricas do Buffer,
slots de agendamento, render como plugin, downloader com limiter, healthcheck, `dry-run` com fakes.

**Do linkedin-curador:** tabela única `items`, triagem como etapa própria, `style-guide.md` separado do prompt,
🔁 Refazer com instrução, 🏷 Editar título, `doctor` e `scan`, `firstComment`, `composePost`, modos do Buffer (`draft/queue/now`),
`/fila` agrupada por status, crédito oculto (modo "autoridade").

---

## 4. Migração em fases

| Fase | Entrega | Critério de pronto |
|---|---|---|
| 0. Contratos | `Draft`, `Item`, estados, `Source`, `Publisher`, `Preparer`, layout do Telegram | snapshots das mensagens aprovados por você |
| 1. Motor | `engine` + `telegram` + `cli`, a partir do código do linkedin-curador (menor) + policy/fila/fontes do perfil-noticias | testes dos dois projetos que cobrem o motor passando no pacote |
| 2. LinkedIn no motor | `linkedin-curador` vira `profiles/linkedin-exemplo` + fonte `x-feed` | **zero** código no perfil; mesmo comportamento |
| 3. Notícias no motor | template `news-card` (render, radar como fonte de trends, multi-plataforma, métricas); migração do SQLite `findings+posts → items` | rodando lado a lado 1 semana sem regressão |
| 4. Prova | perfil de astronomia criado só com `auto-curator create` + config | nenhuma mudança no motor |
| 5. Abrir | README, exemplos sem dados pessoais, licença, CI | — |

A fase 3 é a mais cara (render, vídeo, Instagram/TikTok, banco com histórico). A fase 4 é o teste real do pacote.

---

## 5. Open source e dinheiro

**Cuidados antes de abrir:**
- Fontes por navegador (X, Instagram) violam os Termos dessas redes. No repo público, deixe-as como plugins opcionais
  com aviso, e use como padrão fontes legítimas: RSS, Google News, APIs oficiais (Bluesky, Reddit, YouTube, arXiv, NASA).
- Mídia de terceiros: manter crédito, URL de origem guardada e caminho de remoção.
- "Nada publica sem aprovação humana" como princípio do projeto: é o diferencial e a defesa.
- Tirar dos exemplos: handles da conta de leitura, chat ids, nomes reais de perfis monitorados.

**Licença:** MIT no motor para adoção; templates de nicho testados podem ficar fora (pagos).

**Caminhos de receita (do mais rápido ao mais caro):**
1. Perfis próprios monetizados (publi, afiliados) — o kit é a vantagem de custo.
2. Templates de nicho pagos: prompts + evals + render + fontes testadas (ex.: "notícias de nicho", "autoridade no LinkedIn").
3. Serviço "feito para você": montar e operar o perfil de um cliente.
4. SaaS hospedado (bot pronto, sem setup). Exige multi-tenant, cobrança e só fontes legítimas; é o maior esforço.

---

## 6. Decisões (tomadas em 2026-11-14)

1. Uma tabela `items` em vez de `findings + posts`.
2. Comandos em pt-BR com aliases em inglês.
3. `/fila` = itens em andamento; `/agenda` = agendamentos do Buffer.
4. Um processo por perfil.
5. Bun + Node 22.
6. Nome: `auto-curator-kit`.
