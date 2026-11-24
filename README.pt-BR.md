[English](README.md) · **Português**

# auto-curator-kit

Motor reutilizável para rodar **perfis de redes sociais curados por IA**. Ele lê fontes (RSS, Google News, Google Trends, links que você envia), faz a triagem com um modelo barato e a curadoria com um modelo melhor, prepara a mídia e manda cada post para a sua aprovação no Telegram. Só depois do seu ✅ o post é agendado no Buffer ou entregue a você para publicar à mão.

Versão atual: **0.4.0** (ainda sem release publicada).

Um perfil é uma pasta de configuração (`profile.json`, `style-guide.md` e prompts opcionais), não código. Criar um perfil novo não exige editar o motor.

```text
 Fontes: RSS · Google News · Google Trends · /add · navegador (opcional)
   │
   ▼  ingest (a cada 30 min) + pré-filtro sem IA (repetidos, antigos, padrões bloqueados)
 Triagem (LLM barato)                 nota 0–100; abaixo de triageMinScore vira skipped
   │
   ▼
 Curadoria (LLM melhor)               Draft: veredito, título, texto, hashtags, riskFlags
   │                                  a policy do perfil aplica as regras no código
   ▼                                  limite de caracteres por destino (uma nova tentativa)
 Mídia (render | original | none)     estado ready
   │
   ▼
 Aprovação no Telegram  ◄──────────── nada sai daqui sem o seu ✅
   │
   ├──► Buffer (rascunho, fila ou agora)
   └──► manual (o bot manda o texto final e você publica, depois toca "Publiquei")
```

## Princípios

- **Nada publica sem aprovação humana.** Todo item passa pelo Telegram. O bot só responde a chat ids listados em `TELEGRAM_ALLOWED_CHAT_IDS`.
- **Texto acima do limite não é aprovável.** Se o texto final de um destino passa do limite de caracteres (ex.: Threads, 500), o rascunho vira `needs_human`, sem botão ✅ Aprovar. Você pode refazer (🔁), editar ou rejeitar.
- **Um processo por perfil.** Cada perfil tem o seu bot, o seu banco SQLite, o seu teto de gasto com IA e o seu `.env`.
- **Perfil é configuração, não código.** Fontes, destinos, limites e regras editoriais ficam no `profile.json`. Voz, público e assuntos ficam no `style-guide.md` e nos prompts.

## Requisitos

| Ferramenta | Obrigatória? | Para quê |
|---|---|---|
| Node 22.13.0+ (`^22.13.0 \|\| >=23.4.0`) | sim | runtime (o banco usa `node:sqlite`) |
| bun 1.3.13 | sim | instalar dependências e rodar os scripts (`packageManager`: bun@1.3.13) |
| ffmpeg | não | vídeo renderizado (estratégia `render` com vídeo) |
| yt-dlp | não | baixar vídeo de terceiros (fontes com vídeo) |
| Google Chrome | não | fontes de navegador (`x-feed`, `instagram-profile`); o script de apoio é para macOS |

## Início rápido

```bash
bun install

# 1. cria profiles/<id>/ a partir de um template (news-card ou thought-leader)
bun run create meu-perfil --template news-card --name "Meu Perfil"

# 2. edite profiles/meu-perfil/profile.json (fontes e destinos) e preencha style-guide.md

# 3. segredos do perfil
cp profiles/meu-perfil/.env.example profiles/meu-perfil/.env   # preencha token, chat ids e chaves de IA

# 4. confere tudo (❌ precisa ser corrigido; ⚠️ é aviso)
bun run doctor --profile meu-perfil

# 5. lê as fontes uma vez, sem IA, e mostra o que passa no pré-filtro
bun run scan --profile meu-perfil

# 6. (opcional, gasta IA) roda os casos de regressão do Curador
bun run eval --profile meu-perfil

# 7. liga o bot e o agendador (fica rodando; Ctrl+C para parar)
bun run start --profile meu-perfil
```

Para testar o pipeline inteiro sem rede e sem IA, rode `bun run dry-run` (com ou sem `--profile`).

Detalhes de cada passo: [docs/PERFIL.md](docs/PERFIL.md). Para deixar rodando no Mac ou no Docker: [docs/DEPLOY.md](docs/DEPLOY.md).

## Estrutura do repositório

| Caminho | Conteúdo |
|---|---|
| `packages/contracts` | Tipos e schemas zod: `profile.json`, `models.json`, template, `Item` e estados, `Draft`, portas (interfaces). Sem dependências de runtime. |
| `packages/engine` | Carga do perfil e do `.env`, banco SQLite com migrações, cliente LLM (fallback e teto mensal), prompts, policy (veto e regras editoriais), jobs do pipeline, agendador. |
| `packages/telegram` | Bot por long polling, layout do cartão de aprovação, botões, comandos e textos em pt-BR. |
| `packages/sources` | Registro de fontes (`registerSource`) e as fontes embutidas; leitor de navegador via CDP. |
| `packages/media` | Preparadores de mídia (`none`, `original`, `render`), download com yt-dlp, renderização de cards e vídeo. |
| `packages/publishers` | Publicação pelo Buffer (GraphQL), hospedagem de mídia (R2 ou imgBB) para o Buffer e o contador de cota do Buffer (ver Limitações). |
| `packages/cli` | Comandos (`create`, `doctor`, `scan`, `dry-run`, `eval`, `start`, `status`), resolução de perfil e fiação da aplicação. |
| `templates/` | Modelos de perfil: `news-card` e `thought-leader`. Trazem prompts, `models.json`, defaults e evals. |
| `profiles/` | Perfis locais (exemplos e os seus). Os `.env` nunca são commitados. |
| `deploy/` | LaunchAgent (`install-launchd.sh`, template do plist), `compose.yaml` e `Dockerfile`. |
| `scripts/` | `chrome-reader.sh`: abre o Chrome dedicado de leitura. |
| `docs/` | Documentação: perfil, fontes, arquitetura, deploy e o plano do projeto. |

## Comandos da CLI

Os scripts da raiz chamam `packages/cli/src/main.ts`. O perfil vem de `--profile <id ou caminho>` ou da variável `CURADOR_PROFILE`.

| Comando | O que faz | Opções |
|---|---|---|
| `bun run create <id>` | Cria `profiles/<id>/` (profile.json, style-guide.md, .env.example, evals/) | `--template news-card` (padrão) ou `thought-leader`; `--name "Nome"` |
| `bun run doctor` | Confere configuração, prompts, chaves de API, gasto do mês, bot do Telegram, fontes, Chrome, Buffer, ffmpeg, yt-dlp e pasta de dados. Sai com código 1 se houver ❌. | `--offline` (não faz chamadas de rede) |
| `bun run scan` | Lê as fontes uma vez, sem IA, e mostra cada item e o motivo de ser filtrado. Sem `--dry`, grava os novos itens no banco. | `--dry` (só mostra) |
| `bun run dry-run` | Roda ingestão, triagem, curadoria, mídia, cartão de aprovação e aprovar/rejeitar com dados falsos, em pasta temporária. Sem `--profile`, usa um perfil sintético. | — |
| `bun run eval` | Roda os casos de `templates/<template>/evals/cases.json` e `profiles/<id>/evals/cases.json` no modelo real. Gasta IA. | `--case <nome>` (filtra por nome) |
| `bun run start` | Liga o bot do Telegram e o agendador (ingestão e pipeline). Trava de instância única por perfil. | — |
| `bun run status --profile <id>` | Mostra contagens por estado, gasto do mês, limites e as últimas execuções. | — |

Todos aceitam `--profile` (ou `-p`) e `--help` (ou `-h`). Opções desconhecidas são erro.

## Comandos do bot no Telegram

Os comandos são em português. Os aliases em inglês também funcionam. Mensagens de chats fora de `TELEGRAM_ALLOWED_CHAT_IDS` são ignoradas e não recebem resposta. Se `TELEGRAM_ALLOWED_USER_IDS` estiver definido, o remetente também precisa estar nessa lista.

| Comando | Alias | O que faz |
|---|---|---|
| `/add <link ou texto>` | — | Cria um item agora. Colar só o link também funciona. |
| `/ler` | `/scan` | Roda as fontes agora. |
| `/pendentes` | `/pending` | Lista o que espera a sua aprovação. |
| `/fila` | `/queue` | Tudo em andamento, agrupado por estado. |
| `/agenda` | `/schedule` | O que está agendado no Buffer. |
| `/refazer <id> <instrução>` | — | Refaz o texto de um item pendente, ou aprovado que ainda não tem nada na fila de envio. Recusa item já na fila e item já publicado. |
| `/furar <id>` | `/bump` | Põe o item na frente da fila. |
| `/desfurar <id>` | `/unbump` | Tira a prioridade do item. |
| `/status` | — | Contagens, gasto de IA, limite diário e motivo de espera, se houver. |
| `/pausar` | `/pause` | Pausa a ingestão e o pipeline agendados. `/ler` e `/add` continuam funcionando. |
| `/retomar` | `/resume` | Retoma a geração. |
| `/config` | `/configs` | Mostra as configurações que podem ser mudadas pelo Telegram, com os valores atuais. |
| `/definir <chave> <valor>` | `/set` | Muda uma configuração do perfil (ex.: `/definir aprovacoes_dia 5`). Vale após reiniciar o app. Segredos (`.env`) não são alteráveis pelo chat. |
| `/cancelar` | `/cancel` | Cancela a edição em andamento. |
| `/ajuda` | `/help`, `/start` | Lista os comandos. |

Durante um 🔁 Refazer, a resposta `/igual` tenta de novo sem instrução.

### Cartão de aprovação

Cada post chega antes de qualquer publicação, com a mídia preparada e os botões abaixo. Este é um exemplo ilustrativo do formato:

```text
⚠️ Revisar · i_9c1e4b7a2f10 · Telescópio detecta atmosfera em planeta do tamanho da Terra
📊 Confiança 82% · 🎯 Instagram · 🛡 Riscos: single_source
❓ Dúvida: só uma fonte confirmou; checar o comunicado original.
🔗 Fonte: https://www.example.com/noticia  ·  ✍️ Crédito: Fonte: Portal Exemplo
─────────
<texto final, exatamente como será publicado>

[✅ Aprovar]        [❌ Rejeitar]
[✏️ Editar texto]   [🏷 Editar título]
[🔁 Refazer]
```

- ⚠️ **Revisar** aparece quando o veredito é `needs_human` ou há flags de risco. 🆕 **Novo** aparece nos demais casos.
- **Cartão `needs_human`** (texto acima do limite de algum destino): não tem ✅ Aprovar. Mostra o aviso com a contagem (ex.: `threads: 512/500 caracteres, acima do limite`) e os botões de rejeitar, editar e 🔁 Refazer.
- **Rejeitar** pede um motivo (lista do perfil, em `telegram.rejectReasons`) e grava no banco.
- **Refazer** pede uma instrução ao Curador, ou `/igual` para tentar de novo.
- Em destinos manuais, a aprovação manda a mídia final e o texto para copiar, com os botões **Abrir** (se houver `composeUrl`) e **Publiquei**.

## Limites por destino e teto diário

- **Limite de caracteres (`maxChars`).** Cada destino pode ter o limite do texto final (corpo, hashtags e crédito). Sem o campo, o Threads por Buffer usa 500 por compatibilidade. Quando o texto passa do limite, o Curador recebe o número e tenta uma vez; se ainda passar, o rascunho vira `needs_human` (ver o cartão acima). O texto nunca é cortado no meio.
- **Teto diário (`dailyCap`).** Quando o destino já publicou o máximo do dia, o item é adiado para o primeiro horário com vaga, respeitando a janela (`window`) e o intervalo mínimo (`minIntervalMinutes`). O adiamento vai até `maxDeferDays` dias (padrão 7). Sem vaga nesse prazo, o item vai para envio manual, com a nota no registro.

## Documentação

- [docs/PERFIL.md](docs/PERFIL.md): criar e ajustar um perfil, referência do `profile.json`, prompts, veto, evals e variáveis de ambiente.
- [docs/FONTES.md](docs/FONTES.md): cada tipo de fonte, opções, chave de deduplicação e exemplos; como escrever e registrar uma fonte nova.
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md): pacotes, máquina de estados do item, portas, tabelas do banco e cliente LLM.
- [docs/DEPLOY.md](docs/DEPLOY.md): LaunchAgent por perfil, Docker Compose, Chrome dedicado e vários perfis no mesmo Mac.
- [docs/PLANO.md](docs/PLANO.md): diagnóstico, decisões e fases da migração.

## Desenvolvimento

```bash
bun run test        # vitest (packages/*/test)
bun run typecheck   # tsc --noEmit
```

A integração contínua roda typecheck e testes no Node 22.13.0 e no Node 26 (ver `.github/workflows/ci.yml`). Para contribuir, veja [CONTRIBUTING.md](CONTRIBUTING.md). Para reportar uma vulnerabilidade, veja [SECURITY.md](SECURITY.md).

## Limitações conhecidas

- **Fontes de navegador (X e Instagram) violam os Termos de Uso dessas redes.** Use uma conta secundária de leitura, mantenha o volume baixo (os limites das fontes existem para isso) e trate-as como opcionais. Elas exigem um Chrome dedicado aberto e logado.
- **Publicação automática só existe via Buffer.** Não há integração direta com LinkedIn, Instagram ou TikTok. Para essas redes, use o Buffer ou o modo `manual`.
- **Cota do Buffer ainda não ligada ao publicador.** O pacote `publishers` já tem o contador de cota compartilhado por organização e a checagem de fila cheia (limite de posts agendados por canal, no plano Free), mas o publicador ainda não usa essas checagens. Até ligar, o teto é só o `dailyCap` do destino.
- **Um canal do Buffer por plataforma.** Defina `BUFFER_CHANNEL_<PLATAFORMA>` ou `channelEnv` no destino. Sem a variável, o canal só é descoberto se houver exatamente um conectado na conta.
- **Mídia para o Buffer precisa de hospedagem pública.** Configure `IMGBB_API_KEY` ou as variáveis `R2_*`. Sem isso, o Buffer recebe só o texto e o destino perde a mídia.
- **Vídeo de terceiros depende do yt-dlp.** Sem ele, só imagens são usadas.
- **Docker não atende fontes de navegador.** `BROWSER_CDP_URL` só aceita `127.0.0.1` (o Chrome tem de estar na mesma máquina e namespace de rede). Para esses perfis, use o LaunchAgent.
- **Autorização do bot é por chat.** Use um chat privado; em grupo, defina `TELEGRAM_ALLOWED_USER_IDS`.
- **Os intervalos `publish` e `metrics` não são agendados.** Só `ingest` e `pipeline` rodam como jobs.

## Licença

A definir. Este repositório ainda não tem arquivo de licença: o uso, a cópia e a redistribuição não estão autorizados até a licença ser publicada.
