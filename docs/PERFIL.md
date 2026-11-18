# Perfis: criação, configuração e ajuste

Um perfil é uma pasta em `profiles/<id>/`. Ele diz **o que** coletar, **para onde** publicar, **quais regras** valem e **com qual voz** o Curador escreve. Nada disso exige mudar código.

## 1. Criar um perfil

```bash
bun run create <id> --template news-card --name "Nome do perfil"
```

- `<id>`: letras minúsculas, números e hífen (até 41 caracteres). Ex.: `astronomia`, `meu-linkedin`.
- `--template`: `news-card` (padrão) ou `thought-leader`.
- `--name`: nome exibido nas mensagens do Telegram. Sem ele, o nome sai do id.

O comando recusa sobrescrever uma pasta existente. Ele grava:

```text
profiles/<id>/
  profile.json       configuração do perfil
  style-guide.md     voz, público e assuntos (lido pelo Curador a cada execução)
  .env.example       modelo dos segredos; copie para .env
  evals/cases.json   casos de regressão do Curador (começa vazio)
```

Depois: edite `profile.json` e `style-guide.md` (o `doctor` avisa enquanto houver "(preencher)"), copie `.env.example` para `.env` e rode `bun run doctor --profile <id>`.

## 2. Estrutura completa de uma pasta de perfil

```text
profiles/<id>/
  profile.json        obrigatório
  style-guide.md      obrigatório (o doctor exige que exista e não esteja vazio)
  .env                segredos deste perfil (nunca commitar)
  prompts/            opcional: triage.md e/ou curator.md, substituem os do template
  veto.json           opcional: regras de texto (ver seção 7), caminho em editorial.vetoFile
  evals/cases.json    opcional: casos de regressão (ver seção 8)
  brand/ (ou outro)   opcional: logo, referido em brand.logo (relativo a esta pasta)
```

O `models.json` vem do template. Um perfil pode apontar para outro, em `models` (caminho relativo à pasta do perfil).

## 3. Herança de template

Na carga do perfil (`loadProfile` em `packages/engine/src/config.ts`):

1. O `template.json` do template traz `defaults`.
2. Os `defaults` são mesclados com o `profile.json` por **merge profundo**: objetos se fundem recursivamente; **arrays e valores escalares do perfil substituem** os do template.
3. O resultado passa pelo schema zod, que aplica os valores padrão listados abaixo.

Consequência: para acrescentar um item a uma lista herdada (ex.: `riskFlags`), copie a lista inteira no perfil.

Defaults de cada template:

| Campo | `news-card` | `thought-leader` |
|---|---|---|
| `media.strategy` | `render` | `original` |
| `media.template` | `auto` | (padrão do schema: `auto`) |
| `editorial.credit` | `show` | `hide` |
| `editorial.riskFlags` | health, minor, private_life, accusation, crime_or_lawsuit, death, violence, sexual_content, leaked_content, single_source, unverified, outdated | confidential, controversial, personal, attack, unverified, outdated |
| `editorial.forceReview` | todas exceto `violence` e `crime_or_lawsuit` | confidential, controversial, personal, attack, unverified, outdated |
| `editorial.skip` | `violence`, `crime_or_lawsuit` | `[]` |
| `editorial.body.maxChars` | 2000 | 3000 |
| `editorial.headline.maxChars` | 160 | 100 |
| `editorial.hashtags` | min 3, max 6 | min 3, max 5 |
| `editorial.firstComment` | `false` | `true` |
| `pipeline.maxPendingApproval` / `dailyApprovalCap` | padrão (5 / 8) | 3 / 4 |
| `pipeline.subjectCooldownHours` | 4 | padrão (0) |
| `draftExtraRequired` | `categoryTag` | nenhum |

## 4. Referência do `profile.json`

Os valores padrão são os do schema (`packages/contracts/src/config.ts`), **antes** da herança do template. "obrig." = obrigatório.

### Raiz

| Campo | Tipo | Padrão | Notas |
|---|---|---|---|
| `id` | string | obrig. | Regex `^[a-z0-9][a-z0-9-]{0,40}$`. Deve bater com o nome da pasta. |
| `name` | string | obrig. | Nome nas mensagens. |
| `template` | string | `thought-leader` | Pasta em `templates/`. O `create` sempre escreve o template explicitamente. |
| `language` | string | `pt-BR` | |
| `timezone` | string | `America/Sao_Paulo` | Usada para contar o dia (limite diário) e o mês (orçamento de IA). |
| `sources` | array | `[{ "type": "manual" }]` | Ver [FONTES.md](FONTES.md). |
| `destinations` | array | obrig. (mín. 1) | Ver abaixo. |
| `media` | objeto | ver abaixo | |
| `brand` | objeto | opcional | Só usado pela estratégia `render`. |
| `editorial` | objeto | ver abaixo | |
| `pipeline` | objeto | ver abaixo | |
| `telegram` | objeto | `{}` | |
| `models` | string | `default` | `default` = `templates/<template>/models.json`; senão, caminho relativo à pasta do perfil. |

### `sources[]`

Cada entrada tem `type` (obrig.), `name` (opcional), `enabled` (padrão `true`) e as opções do tipo. Chaves desconhecidas são erro. Lista completa em [FONTES.md](FONTES.md).

### `destinations[]`

| Campo | Padrão | Notas |
|---|---|---|
| `platform` | obrig. | Texto livre (`instagram`, `linkedin`, `tiktok`...). Aparece capitalizado nas mensagens. |
| `publisher` | `manual` | `buffer` agenda pelo Buffer; `manual` manda o texto final pelo Telegram para você publicar. |
| `mode` | `draft` | Só Buffer: `draft` salva como rascunho; `queue` põe na próxima vaga; `now` publica já. |
| `channelEnv` | `BUFFER_CHANNEL_<PLATAFORMA>` | Nome da variável que tem o id do canal no Buffer. |
| `dailyCap` | `4` | Publicações por dia neste destino. Acima do limite, o destino cai para publicação manual com aviso. |
| `minIntervalMinutes` | `0` | Intervalo mínimo entre duas publicações deste canal. Quem chega antes espera numa fila local e é enviado pelo job `publish`. |
| `window` | — | Janela de horário no fuso do perfil, `{ "start": "08:00", "end": "22:00" }`. Pode cruzar a meia-noite (`22:00` a `02:00`). Fora dela, o item espera na fila. |
| `composeUrl` | — | URL do botão "Abrir <plataforma>" no fluxo manual. |
| `only` | `any` | `any`, `image` ou `video`: só recebe mídias desse tipo. Se não houver nenhuma, o destino é ignorado. |

Se um destino com `publisher: "buffer"` não tiver `BUFFER_API_KEY`, o `start` avisa e a aprovação cai no fluxo manual.

### `media`

| Campo | Padrão | Notas |
|---|---|---|
| `strategy` | `original` | `render` gera card (e vídeo, com ffmpeg); `original` usa a mídia da fonte, baixando o que for preciso; `none` é só texto. |
| `template` | `auto` | Só `render`: `card`, `video_split` ou `auto` (`video_split` quando há vídeo e ffmpeg; senão `card`). |
| `maxImages` | `4` | Máximo de imagens preparadas por item. |
| `downloadVideo` | `true` | Baixa vídeo com yt-dlp (precisa do downloader). |
| `maxVideoSec` | `300` | Duração máxima do vídeo baixado. |

### `brand` (opcional, para `render`)

| Campo | Padrão | Notas |
|---|---|---|
| `name` | obrig. | Nome no card. |
| `handle` | `""` | Ex.: `@seuperfil`. |
| `logo` | — | Caminho relativo à pasta do perfil. |
| `colors.primary` | `#4A22E8` | |
| `colors.accent` | `#FF5A6E` | |
| `colors.background` | `#FFFFFF` | |
| `colors.text` | `#111111` | |
| `fontFamily` | `Inter` | |

Se `brand` não existir, o card usa `name` do perfil e as cores padrão.

### `editorial`

| Campo | Padrão | Efeito |
|---|---|---|
| `credit` | `show` | `show`: o texto leva o crédito da fonte (`sourceCredit` obrigatório). `hide`: escreve como conteúdo próprio. |
| `riskFlags` | `unverified`, `outdated` | Flags que o modelo pode usar. Flag fora da lista (e fora de `skip`/`forceReview`/veto) vira revisão humana. |
| `forceReview` | `unverified` | Qualquer dessas flags força `needs_human`. |
| `skip` | `[]` | Qualquer dessas flags descarta o item (`skip`). |
| `body.minChars` / `maxChars` | `20` / `2200` | Texto curto demais vira revisão; longo demais é cortado. |
| `headline.maxChars` | `120` | Título é cortado no limite. |
| `hashtags.min` / `max` | `0` / `6` | Menos que `min` vira revisão; mais que `max` é cortado. |
| `firstComment` | `false` | Permite o primeiro comentário (LinkedIn, por exemplo). Se `false`, o campo é removido. |
| `minConfidence` | `0.6` | Confiança abaixo disso força revisão humana. |
| `vetoFile` | — | Caminho (relativo à pasta do perfil) do `veto.json`. Ver seção 7. |
| `blockedPatterns` | `[]` | Regexes sem diferenciar maiúsculas. Item que casa é descartado **antes** de qualquer chamada de IA. Regex inválida é ignorada. |

A policy (`packages/engine/src/policy.ts`) aplica essas regras **depois** do Curador, no código. Ela só endurece o veredito (`publish` → `needs_human` → `skip`); nunca transforma um `skip` em algo mais permissivo.

### `pipeline`

| Campo | Padrão | Efeito |
|---|---|---|
| `intervalsMinutes.ingest` | `30` | Intervalo da ingestão (agendada). |
| `intervalsMinutes.pipeline` | `5` | Intervalo do pipeline: triagem, curadoria, mídia e envio (agendado). |
| `intervalsMinutes.publish` | `5` | **Lido, mas não agendado.** |
| `intervalsMinutes.metrics` | `360` | **Lido, mas não agendado.** |
| `triageMinScore` | `60` | Nota da triagem abaixo disso vira `skipped`. |
| `triageBatchSize` | `10` | Itens por chamada de triagem. |
| `maxItemAgeHours` | `24` | Itens mais velhos são descartados antes da triagem; os pendentes expiram. |
| `maxNewPerSource` | `15` | Novos itens aceitos por fonte a cada ingestão (os de maior engajamento). |
| `curatorPerTick` | `3` | Itens curados por execução do pipeline. |
| `maxAttempts` | `3` | Falhas de LLM ou de mídia até o item ser desistido (`skipped`). |
| `maxPendingApproval` | `5` | Não gera novos enquanto houver tantos aguardando decisão. |
| `dailyApprovalCap` | `8` | Máximo de cartões enviados por dia. |
| `subjectCooldownHours` | `0` | Intervalo mínimo entre posts sobre o mesmo autor (`0` = desligado). |
| `urgentBypassScore` | `90` | Nota a partir da qual o item ignora `maxPendingApproval`. |

### `telegram`

| Campo | Padrão | Notas |
|---|---|---|
| `rejectReasons` | `default` | `default` usa a lista embutida; ou um array de `{ "code": "...", "label": "..." }`. `code`: minúsculas, números e `_`, até 20 caracteres. |

Lista padrão (código, rótulo): `sem_contexto` Sem contexto · `midia_errada` Mídia errada · `inventado` Inventado (não está na fonte) · `sem_valor` Sem valor / tema fraco · `fato_duvidoso` Fato duvidoso · `antigo` Antigo · `fora_nicho` Fora do nicho · `outro` Outro · `sem_motivo` Rejeitar sem motivo.

### `models.json` (LLM)

Vem do template, ou aponte `models` para outro arquivo.

| Campo | Padrão | Notas |
|---|---|---|
| `monthlyBudgetBRL` | obrig. | Teto de gasto com IA por mês (perfil de `timezone`). |
| `usdBrl` | `5.5` | Câmbio usado para converter o custo. |
| `roles.triage` / `roles.curator` | obrig. | Cada papel: `baseUrl`, `apiKeyEnv`, `model`, `inputUsdPerM`, `outputUsdPerM`, `maxTokens` (4000), `temperature` (0.2), `jsonMode` (true), `fallback` (um objeto ou uma lista). |

O fallback é tentado em ordem em caso de HTTP 400, 402, 429, 5xx ou erro de rede. Detalhes em [ARQUITETURA.md](ARQUITETURA.md#6-cliente-llm).

## 5. Estilo, voz e prompts

### `style-guide.md`

É lido a cada execução e **anexado aos dois prompts** (triagem e curadoria) dentro do bloco `STYLE GUIDE`. É aqui que mora o nicho: o que entra, o que sai, o público, a voz, o formato dos títulos e das legendas, as hashtags e as proibições. Quanto mais concreto, melhor. Inclua exemplos reais de posts que você gosta.

### Prompts

Cada papel (`triage`, `curator`) é carregado assim:

1. `profiles/<id>/prompts/<papel>.md`, se existir; senão, `templates/<template>/prompts/<papel>.md`. O arquivo do perfil **substitui** o do template por inteiro (não é mesclado).
2. Anexo do `style-guide.md` (bloco `STYLE GUIDE`).
3. Bloco `PROFILE RULES`, **gerado** a partir de `editorial` e `draftExtraRequired`. Ele diz ao modelo os mesmos limites que o código aplica depois:

```text
---
PROFILE RULES (enforced by code after your answer)

Profile: Meu Perfil (language: pt-BR).
- Source credit: ALWAYS fill sourceCredit (e.g. "Fonte: <author or outlet>"); it is shown in the post.
- Allowed riskFlags (use only these): health, minor, ...
- Flags that force human review (verdict needs_human): ...
- Flags that force skip (verdict skip): violence, crime_or_lawsuit.
- Confidence below 0.6 forces human review.
- headline: at most 160 characters.
- body: 20 to 2000 characters.
- hashtags: between 3 and 6.
- firstComment: NOT allowed, leave it out.
- extra must contain these keys: categoryTag.
```

Não repita esses limites no `prompts/*.md`: eles mudam com o `profile.json` e o bloco já vem atualizado.

A primeira linha do prompt deve ter `(prompt vN)` (ex.: `# CURATOR (prompt v2)`). A versão aparece no `doctor` e no `Draft.promptVersion`, então suba o N quando editar. Os prompts são lidos a cada chamada: edições valem sem reiniciar.

## 6. Dados que o template exige (`draftExtraRequired`)

`news-card` exige `extra.categoryTag` (a "tag" em caixa alta do card). Se o modelo não devolver, a policy manda o item para revisão humana com o motivo `Campos obrigatórios ausentes em extra`.

## 7. Regras de veto (`veto.json`)

Serve para regras de texto que não devem depender do modelo. Ative com `editorial.vetoFile`, por exemplo `"vetoFile": "veto.json"`. Formato (conforme `packages/engine/src/policy.ts`):

```json
{
  "vetoFlags": ["violence"],
  "reviewFlags": ["accusation"],
  "flags": {
    "accusation": {
      "keywords": ["acusado", "denunciado"],
      "patterns": ["\\bpreso em\\b"],
      "benign": ["\\bnega\\b"]
    }
  }
}
```

- `vetoFlags` (também aceito como `skipFlags`): acerto no texto gera `skip` (veto).
- `reviewFlags`: acerto gera `needs_human`.
- Uma flag com regras que não esteja em nenhuma das listas vira revisão (falha segura).
- `keywords`: palavras ou expressões, com fronteira de palavra; a comparação ignora maiúsculas e acentos.
- `patterns`: regex JavaScript com a flag `u`, testada sobre o texto **normalizado** (minúsculas, sem acento). Escreva o padrão já em minúsculas e sem acento.
- `benign`: se algum casar na mesma frase, o acerto daquela flag é cancelado.
- O texto analisado é: título e texto da fonte, `headline`, `body` e as afirmações de `facts`. A análise é por frase.
- Acertos viram `riskFlags` do item e aparecem em "Riscos" no cartão.
- O `veto.json` é lido na inicialização: reinicie o `start` depois de editar.

## 8. Casos de regressão (`evals/cases.json`)

`bun run eval --profile <id>` roda os casos do template (`templates/<template>/evals/cases.json`) e os do perfil (`profiles/<id>/evals/cases.json`) contra o modelo real, com a policy aplicada. Gasta IA. Filtre por nome com `--case <trecho>`.

Formato: uma lista. Cada caso:

```json
[
  {
    "name": "post_com_fonte_solida",
    "note": "opcional, para humanos",
    "item": {
      "id": "e01",
      "source": "rss:exemplo",
      "sourceUrl": "https://example.com/noticia",
      "author": "Portal Exemplo",
      "title": "Título da notícia",
      "text": "Texto completo da fonte.",
      "media": [{ "type": "image", "url": "https://example.com/foto.jpg" }],
      "postedAt": "2026-11-07T13:00:00Z",
      "engagement": {},
      "extra": {}
    },
    "expected": {
      "verdict": "publish",
      "alsoAcceptable": ["needs_human"],
      "mustFlag": ["single_source"],
      "headlineMustInclude": [],
      "headlineMustNotInclude": [],
      "sourceCreditMustInclude": ["Portal Exemplo"],
      "sourceCreditMustNotInclude": [],
      "bodyMustInclude": [],
      "bodyMustNotInclude": ["cupom"]
    }
  }
]
```

- `expected` (ou `expect`): obrigatório.
- `verdict`: `publish`, `needs_human` ou `skip`. É comparado com o veredito **final**, depois da policy.
- `alsoAcceptable`: outros vereditos que também passam.
- Os demais campos são opcionais. Os textos são comparados sem diferenciar maiúsculas. Os campos de texto só são checados quando o modelo produziu rascunho.
- `item.origin` aceita `feed`, `profile` ou `manual`. Itens de eval não passam pela triagem.
- Um caso que casa `blockedPatterns` é contado como `skip` sem chamada de IA.

## 9. Variáveis de ambiente

### Carga do `.env`

`loadProfile` lê **somente** `profiles/<id>/.env`. Ele é um parser simples: `CHAVE=valor`, comentários com `#`, aspas opcionais, `export` opcional. **Nunca sobrescreve** uma variável que já exista no ambiente do processo. Por isso o plist e o Docker podem fixar `CURADOR_DATA_DIR` sem conflito.

### Por perfil (no `.env` do perfil)

| Variável | Obrigatória? | Uso |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | sim, para `start` | Token do bot criado no @BotFather. Um bot por perfil. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | sim, para `start` | Chat ids autorizados, separados por vírgula, espaço ou `;`. Aceita o legado `TELEGRAM_ALLOWED_CHAT_ID`. Updates de outros chats são ignorados. |
| `TELEGRAM_ALLOWED_USER_IDS` | não | Segundo fator: ids de usuário (`from.id`) autorizados, no mesmo formato. Se definido, o remetente também precisa estar na lista. |
| `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | ao menos uma por papel | Chaves dos modelos padrão. Os nomes reais são os `apiKeyEnv` do `models.json` (é possível usar outros). |
| `BUFFER_API_KEY` | só com destino `buffer` | Chave da API do Buffer. Sem ela, os destinos `buffer` caem no fluxo manual. |
| `BUFFER_CHANNEL_<PLATAFORMA>` | opcional | Id do canal no Buffer, ex.: `BUFFER_CHANNEL_INSTAGRAM`. Ou o nome dado em `channelEnv`. Sem ela, o canal é descoberto se houver exatamente um conectado. |
| `IMGBB_API_KEY` | para mídia no Buffer | Hospedagem de imagens no imgBB. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL` | alternativa ao imgBB | Cloudflare R2. Usado **só se as cinco** estiverem definidas (tem prioridade sobre o imgBB). |
| `BROWSER_CDP_URL` | só fontes de navegador | Padrão `http://127.0.0.1:9222`. Só aceita `127.0.0.1`. |
| `CURADOR_DATA_DIR` | não | Pasta de dados (banco, mídia, lock). Padrão `data/<id>`. |
| `LOG_LEVEL` | não | `debug`, `info`, `warn` ou `error`. Padrão `info`. |
| `DOWNLOADER_DISABLED` | não | `1`, `true`, `yes` ou `on` desliga qualquer download. |
| `DOWNLOADER_MAX_MB` | não | Tamanho máximo de arquivo baixado. |
| `YTDLP_BIN` | não | Caminho do yt-dlp, se não estiver no PATH. |
| `FFPROBE_BIN` | não | Caminho do ffprobe. |
| `YTDLP_COOKIES_FILE` | não | Arquivo de cookies para o yt-dlp. |

### Globais (CLI e infraestrutura)

| Variável | Uso |
|---|---|
| `CURADOR_PROFILE` | Perfil padrão quando `--profile` não é passado. |
| `PROFILES_DIR` | Pasta dos perfis (padrão `profiles/` do repositório). |
| `TEMPLATES_DIR` | Pasta dos templates (padrão `templates/`). |
| `PROFILE` | Só no container Docker: id do perfil que o `CMD` inicia. |
| `CHROME_READER_PORT`, `CHROME_READER_PROFILE`, `CHROME_APP` | Só `scripts/chrome-reader.sh`: porta de depuração, pasta do perfil do Chrome e caminho do app. Ver [DEPLOY.md](DEPLOY.md#3-chrome-dedicado-scriptschrome-readersh). |

## 10. Checklist de um perfil novo

1. `bun run create <id> --template <t> --name "..."`.
2. Editar `profile.json`: fontes ativas, destinos, `brand` (se render), `editorial`, `pipeline`.
3. Preencher `style-guide.md` sem trechos "(preencher)".
4. Criar o bot no @BotFather, descobrir o chat id com @userinfobot, copiar `.env.example` para `.env` e preencher.
5. `bun run doctor --profile <id>` até não haver ❌.
6. `bun run scan --profile <id>` e conferir o pré-filtro.
7. Preencher `evals/cases.json` com 5 a 10 casos reais (bons e ruins) e rodar `bun run eval --profile <id>`.
8. `bun run start --profile <id>`, ou o LaunchAgent (ver [DEPLOY.md](DEPLOY.md)).

