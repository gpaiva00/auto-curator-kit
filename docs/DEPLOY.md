# Deploy

A regra do projeto é **um processo por perfil**: cada perfil tem o seu bot, o seu banco, o seu orçamento de IA e o seu `.env`. Há dois jeitos de rodar: um LaunchAgent do macOS por perfil, ou um serviço por perfil no Docker Compose. Os dois chamam o mesmo comando, `bun run start --profile <id>`.

Antes de colocar qualquer perfil no ar, rode `bun run doctor --profile <id>` até não haver ❌.

## 1. LaunchAgent (macOS)

Use este caminho para perfis que dependem do Chrome dedicado (fontes `x-feed` e `instagram-profile`), porque o Chrome roda na mesma máquina e o `BROWSER_CDP_URL` só aceita `127.0.0.1`.

### Instalar

```bash
deploy/install-launchd.sh <id>
```

O script (`deploy/install-launchd.sh`):

- valida o id e confere que `profiles/<id>/profile.json` existe (avisa se não houver `.env`);
- exige `bun` no PATH;
- cria `data/<id>/` e grava `~/Library/LaunchAgents/com.auto-curator.<id>.plist` a partir de `deploy/launchd.plist.template`, preenchendo caminho do repositório, do bun, do HOME e do PATH;
- valida o plist com `plutil`;
- **não carrega o job.** Ele imprime os comandos para você rodar.

### Ligar, ver e desligar

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.auto-curator.<id>.plist   # liga
launchctl print gui/$(id -u)/com.auto-curator.<id> | head -20                        # estado
launchctl bootout gui/$(id -u)/com.auto-curator.<id>                                 # desliga
```

Para aplicar mudanças de `profile.json` ou do `.env`, desligue e ligue de novo: a configuração é lida na inicialização. Prompts e `style-guide.md` são relidos a cada chamada, então não precisam de reinício. O `veto.json` é lido na inicialização.

### O que o plist faz

Gerado a partir de `deploy/launchd.plist.template`:

| Chave | Valor | Efeito |
|---|---|---|
| `ProgramArguments` | `caffeinate -i <bun> run start --profile <id>` | Mantém o Mac acordado enquanto o processo roda. |
| `WorkingDirectory` | raiz do repositório | Caminhos relativos funcionam. |
| `EnvironmentVariables` | `PATH`, `HOME`, `CURADOR_DATA_DIR=<repo>/data/<id>` | Fixa a pasta de dados do perfil. Como o `.env` nunca sobrescreve variáveis já definidas, este valor prevalece sobre um `CURADOR_DATA_DIR` do `.env`. |
| `RunAtLoad` | `true` | Sobe ao carregar o job, inclusive após login. |
| `KeepAlive` | `SuccessfulExit = false` | Reinicia depois de uma falha. Não reinicia após uma parada limpa (SIGINT ou SIGTERM, código 0). |
| `ThrottleInterval` | `30` | Espera 30 s entre reinícios. |
| `ExitTimeOut` | `25` | Tempo para encerrar graciosamente antes do kill. |
| `StandardOutPath` / `StandardErrorPath` | `data/<id>/launchd.log` | Logs de stdout e stderr no mesmo arquivo. |

A instância única é garantida pelo próprio `start`: o arquivo `data/<id>/.start.lock` guarda o pid. Outra instância do mesmo perfil sai com código **75**, e o launchd tenta de novo após `ThrottleInterval`. Um lock cujo pid já não existe é reaproveitado.

## 2. Docker Compose

`deploy/compose.yaml` define **um serviço por perfil**. Rode a partir da raiz do repositório:

```bash
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml logs -f astronomia   # nome do serviço
docker compose -f deploy/compose.yaml down
```

Cada serviço:

- usa a imagem de `deploy/Dockerfile` (Node 22 slim, com ffmpeg, python3 + yt-dlp e fontconfig, e o bun como gerenciador de pacotes);
- recebe `PROFILE=<id>` e `CURADOR_DATA_DIR=/data`;
- monta `../profiles` em `/app/profiles` **somente leitura** (perfil, guia de estilo, prompts, evals e o `.env` do perfil);
- guarda o estado num volume nomeado `<id>-data` montado em `/data` (banco, mídia baixada e renders);
- reinicia com `restart: unless-stopped`.

O `CMD` da imagem é `bun run start --profile "$PROFILE"`. Se `PROFILE` estiver vazio, o contêiner recusa iniciar.

Para adicionar um perfil: copie o bloco do serviço comentado no `compose.yaml`, troque o nome do serviço, `container_name`, `PROFILE` e o volume de dados, e declare o volume em `volumes:`.

**Limitação:** o contêiner não enxerga o Chrome da máquina. Como `BROWSER_CDP_URL` só aceita `127.0.0.1`, as fontes `x-feed` e `instagram-profile` não funcionam dentro do Docker. Perfis que usam essas fontes devem rodar pelo LaunchAgent.

O healthcheck do compose só verifica se o processo Node responde. O sinal real de vida é o bot respondendo no Telegram.

## 3. Chrome dedicado (`scripts/chrome-reader.sh`)

As fontes de navegador leem o X e o Instagram por um Chrome que você abre só para isso, com a porta de depuração ligada somente em `127.0.0.1`. O script `scripts/chrome-reader.sh` faz isso no macOS.

```bash
scripts/chrome-reader.sh [nome] [window|headless|stop]
```

| Uso | Efeito |
|---|---|
| `scripts/chrome-reader.sh` | Perfil `default`, com janela, na porta 9222. |
| `scripts/chrome-reader.sh astronomia` | Perfil `astronomia`, com janela, na porta 9222 (ou na porta que você definir). |
| `scripts/chrome-reader.sh astronomia headless` | Sem janela. Não recomendado: sites barram com mais facilidade e você não vê desafios. |
| `scripts/chrome-reader.sh astronomia stop` | Encerra o Chrome desse perfil. |
| `scripts/chrome-reader.sh -h` | Mostra a ajuda do cabeçalho do script. |

Comportamento:

- O perfil do Chrome fica em `~/.auto-curator/chrome-<nome>` (troque com `CHROME_READER_PROFILE`). Ele é separado do seu Chrome do dia a dia.
- A porta vem de `BROWSER_CDP_URL` **do ambiente do shell** (o script não lê o `.env` do perfil; se quiser usar essa variável, exporte-a antes), senão de `CHROME_READER_PORT`, senão **9222**. O valor de `BROWSER_CDP_URL` no `.env` do perfil precisa bater com a porta escolhida.
- O app é `/Applications/Google Chrome.app` (troque com `CHROME_APP`).
- Se já houver um Chrome com depuração naquela porta, o script não abre outro.
- No modo com janela, o Chrome abre em segundo plano, sem roubar o foco, em `x.com/home` e `instagram.com`.
- No `.env` do perfil: `BROWSER_CDP_URL=http://127.0.0.1:<porta>`.

Primeira vez:

1. Abra o Chrome dedicado e entre no X e no Instagram **com uma conta secundária de leitura**, nunca com a conta principal.
2. Resolva confirmações de idade e desafios na tela.
3. Deixe o Chrome aberto. Se você fechá-lo, o leitor para, mas o resto do pipeline segue. O `doctor` mostra "Chrome dedicado acessível" ou a falha.

O script avisa que ler X e Instagram por navegador automatizado vai contra os Termos dessas redes. Mantenha o volume baixo; os limites das fontes (`limits`) existem para isso.

## 4. Vários perfis no mesmo Mac

Checklist para cada perfil novo:

- [ ] **Id único** em `profiles/<id>/`, e um LaunchAgent próprio (`install-launchd.sh <id>`).
- [ ] **Bot próprio**: `TELEGRAM_BOT_TOKEN` diferente por perfil. Um bot não pode ter dois pollings, por isso o `start` trava a instância.
- [ ] **Chat ids autorizados** em `TELEGRAM_ALLOWED_CHAT_IDS` (podem ser os mesmos em todos os perfis).
- [ ] **Pasta de dados separada**: o plist fixa `CURADOR_DATA_DIR=<repo>/data/<id>`. Não reaproveite a pasta de outro perfil.
- [ ] **Chrome por perfil**, se usar fontes de navegador: nome diferente (`chrome-reader.sh <nome>`), porta diferente e `BROWSER_CDP_URL` correspondente no `.env`. Duas instâncias do mesmo Chrome dedicado na mesma porta não funcionam.
- [ ] **Orçamento de IA por perfil**: cada processo tem o seu `llm_usage` e o seu `monthlyBudgetBRL`. Um estouro num perfil não para os outros.
- [ ] **Chave do Buffer**: pode ser a mesma conta em vários perfis, desde que os canais (`BUFFER_CHANNEL_*`) sejam os de cada perfil.
- [ ] `bun run doctor --profile <id>` sem ❌.

## 5. Operação

| Situação | O que fazer |
|---|---|
| Ver o estado do perfil | `bun run status --profile <id>` (contagens, gasto, últimas execuções). |
| Logs do LaunchAgent | `tail -f data/<id>/launchd.log` |
| "Já existe uma instância rodando" (código 75) | Confira se o LaunchAgent já está carregado (`launchctl print`). Se não estiver, outro processo está segurando o lock: pare-o. Um lock órfão (pid morto) é retomado sozinho. |
| Bot parou de responder | Veja `launchd.log`. Se o processo caiu, o launchd reinicia após 30 s. Se o processo está vivo mas mudo, reinicie (bootout e bootstrap). |
| Trocou `profile.json`, `.env` ou `veto.json` | Reinicie o perfil (bootout e bootstrap, ou `docker compose ... up -d` no Docker). |
| Trocou prompt ou `style-guide.md` | Não precisa reiniciar. |
| Pausar sem desligar | No Telegram: `/pausar`. Para retomar: `/retomar`. A pausa é gravada no banco e sobrevive a reinícios. |
| Backup | Pare o perfil e copie `data/<id>/` (inclui `curator.db`, `curator.db-wal` e `media/`). |

Antes de atualizar o código: pare os perfis, rode `bun install`, `bun run test` e `bun run typecheck`, e suba os perfis de novo.
