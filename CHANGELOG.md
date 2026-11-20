# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Versões seguem SemVer; antes da 1.0, minor pode quebrar e patch não.

## [0.2.4] - 2026-11-20

### Adicionado

- **`maxChars` por destino.** `Destination.maxChars` (inteiro positivo, opcional) é o limite do texto final de cada destino: corpo, hashtags e crédito. Sem o campo, só o Threads por Buffer tem padrão (500), por compatibilidade com perfis antigos.
- **Contagem no cartão de aprovação.** Uma linha por destino com limite: `Threads: 487/500 ✅`, ou `Threads: 612/500 ⚠️ vai para envio manual a menos que você edite`. Aprovar continua liberado.
- **Aviso no `doctor`.** Destino com mídia ou Threads por Buffer sem `maxChars` aparece como aviso.

### Corrigido

- **Texto acima do limite do destino vai para envio manual, com a nota certa.** Antes, o Threads recusava o texto no publicador e o item ficava como falha. Agora a regra é genérica no motor, antes da fila e do teto diário: o destino sai como manual com a nota `texto de N caracteres passa do limite de M`. A constante fixa `THREADS_MAX_CHARS` saiu do publicador.

Compatibilidade: um perfil com `maxChars` não carrega no kit 0.2.3 (o schema de destino é estrito). Os outros perfis não mudam.

## [0.2.3] - 2026-11-20

Asset `auto-curator-kit-0.2.3.tgz` · SHA-256 `205921370a8667c6e61e0800ab659d69034eaac659e25342ed1a9cef4baa2bb0`

### Corrigido

- **Teto de gasto tenta o fallback que couber.** Antes, quando o principal estourava o teto de gasto mensal, a chamada falhava inteira, mesmo com um fallback mais barato dentro do teto. Agora cada provider da cadeia entra só se o custo estimado dele (entrada estimada pelo tamanho do texto, mais saída no pior caso com o `maxTokens` do próprio provider, com o preço dele) couber no teto restante. Se o principal não couber, o primeiro fallback que couber é usado, com log de troca sem valores. Se nenhum couber, `BudgetExceededError` é lançado sem nenhuma requisição, como antes.

Não muda contrato: só fica mais permissivo. O erro de teto continua existindo, com o mesmo código, e só é lançado quando nenhum provider cabe.

## [0.2.2] - 2026-11-20

### Corrigido

- **Chave de provider na cadeia de fallback.** Um papel (`triage`, `curator`) é válido quando pelo menos um provider da cadeia tem chave. Antes, a carga e o `start` exigiam a chave do principal, e o bot não subia com a chave só de um fallback. Providers sem chave saem da cadeia ativa na carga, e o `LlmClient` nunca tenta um deles. Papel sem nenhuma chave continua falhando, com a lista das variáveis aceitas.
- **Uma regra só para a cadeia.** `resolveRoleChain` decide a cadeia ativa por papel, e o `doctor`, o `start`, o `eval` e o `LlmClient` usam essa mesma função.
- **Log na carga, sem valores:** `triage: ativo openrouter/<modelo>; pulados: groq (GROQ_API_KEY ausente)`.
- **Teto de gasto com o preço do modelo efetivamente chamado.** Coberto por teste: o gasto registrado no fallback usa o preço do fallback.

Não muda contrato: fica mais permissivo, e nenhum perfil válido deixa de carregar.

## [0.2.1] - 2026-11-19

### Corrigido

- **Curadoria não para no primeiro erro do curador.** Antes, uma falha de rede ou de provedor num item interrompia a curadoria do tick inteiro, e o próximo pontuado só era curado no ciclo seguinte. Agora a falha conta como tentativa do item e a curadoria segue; quando um item termina em skip ou falha, a vaga do teto diário (`dailyApprovalCap`) é liberada no mesmo ciclo. Só o teto de orçamento interrompe.
- **sharp 0.33.5 → 0.35.5** (dependência de execução do pacote de mídia): corrige CVEs de libvips e libheif do `npm audit` (severidade alta). Sem mudança de API.

### Alterado

- Dependência `sharp` em `^0.35.5`.

### Conhecido

- **Aviso de segurança alto no `zod` (2 avisos, GHSA-mrhx-c7xc-m3w5 e relacionados).** A correção publicada é a 4.6.6 ou posterior, que é uma major; este pacote continua em 3.25.x. Aceito pelo CTO e pelo dono: o `zod` valida só a configuração local do perfil, as respostas do LLM (limitadas por `maxTokens`) e os itens do scan local, sem entrada grande e não confiável vinda direto da internet. A migração para zod 4 está prevista para a 0.3.0 (K9).
- **Aviso moderado no `satori` (sem correção publicada), aceito.** O SVG é rasterizado localmente e não é servido a navegador; o texto passa por `sanitizeText`.
- **Regra para o futuro:** se o `zod` passar a validar entrada externa diretamente, essa entrada precisa de limite de tamanho antes do `safeParse`.

## [0.2.0] - 2026-11-18

### Quebra

- **`run` recebe opções, não posição.** Antes: `run(argv, env, io, profilesRoot)`. Agora: `run(argv, { env, io, profilesRoot, plugins })`.
  - Como migrar: `run(argv)` continua igual. Quem passava `env`, `io` ou `profilesRoot` troca por `run(argv, { env, io, profilesRoot })`.
- **`destinations[].publisher` é obrigatório, sem padrão.** O padrão `"manual"` saiu. O valor é um id: `"manual"` (copiar e colar pelo Telegram), `"buffer"`, ou um id de `plugins.publishers`. `"manual"` é reservado pelo kit: um plugin com esse id dá erro na carga.
  - Como migrar: adicione `"publisher": "manual"` (ou `"buffer"`) a cada destino do `profile.json`. Sem o campo, a carga recusa e sugere os dois ids.
- **Schemas estritos em `profile.json` e `models.json`.** Chave desconhecida é erro, com o caminho (`destinations[0].tipo`). O doctor lista todas as chaves de uma vez.
  - Como migrar: remova ou corrija cada chave indicada na mensagem. As opções de fonte (`sources[].url`, `query` etc.) já eram estritas.
- **Dados padrão em `<pasta do perfil>/data`.** Antes: `data/<id>` na raiz do kit. `CURADOR_DATA_DIR` continua como sobrescrita.
  - Como migrar: mova `data/<id>` para `<perfil>/data`, ou defina `CURADOR_DATA_DIR` com uma pasta fora do pacote. Com o kit instalado, o perfil é explícito (`--profile <caminho>` ou `CURADOR_PROFILE`); busca por id exige `PROFILES_DIR`.
- **Perfil ou dados dentro de `node_modules` são recusados** antes de criar o banco.
  - Como migrar: copie o perfil para uma pasta sua e aponte `--profile` para ela.
- **`style-guide.md` e `prompts/` são exigidos na carga.** Perfil sem eles não carrega, e a mensagem mostra o caminho.
  - Como migrar: crie `style-guide.md` no perfil e os prompts `triage.md` e `curator.md` (no perfil ou no template).
- **Piso do Node é 22.13.0** (ou 23.4.0+). Versões anteriores não têm `node:sqlite` sem flag.
  - Como migrar: atualize o Node. Bun não é suportado no consumidor.
- **`@types/node` é peer (`>=22`), não dependência.** Se o projeto não o tiver, o npm instala automaticamente.
- **Variáveis exigidas pelas partes ligadas viram erro na carga**, antes de qualquer rede: `BUFFER_API_KEY` para destino `buffer`; host de mídia (`IMGBB_API_KEY` ou `R2_*`) para destino `buffer` com mídia; chave do modelo primário de cada papel; `TELEGRAM_*` quando o Telegram está ligado.
  - Como migrar: defina as variáveis listadas na mensagem. Nenhum valor é exibido.

### Adicionado

- **Threads como destino do Buffer**, com o limite de 500 caracteres (o publicador recusa o post acima disso, sem chamar o Buffer). Sem comentário do LinkedIn; falha isolada por destino.
- **Testes de paridade com o linkedin-curador**: vídeo como asset no LinkedIn, idade máxima de item, triagem 0-1 para 0-100, duplicata no `/add`, e fallback do LLM em 429, 400 e chave ausente.
- **Plugins do projeto** em `run` e `buildRuntime`, sem registro global:
  - `plugins.sources`: tipos de fonte do projeto. Tipo repetido do kit é erro, a não ser com `override: true`.
  - `plugins.publishers`: mapa `id → Publisher`, ou função `(env, host) => mapa`.
  - `plugins.mediaHost`: substitui o host configurado pelo `.env`.
- **`kitProfileVersion`** no `profile.json`. Versão maior que a suportada é erro; menor gera aviso com o link da migração.
- **`ProfileBundle.warnings`**: avisos de carga que não impedem o uso.
- **Aviso na aprovação** quando um destino com mídia não tem host: o cartão do Telegram mostra a linha, além do doctor.
- **Binário `auto-curator`** (`dist/bin.js`).
- **Checagem de runtime** antes de carregar o motor: Bun e Node abaixo de 22.13 recebem mensagem em português e código 1.
- **`BuildOptions.llm`**: substitui o cliente de LLM (para testes, sem rede).

### Alterado

- Publicação usa o id do destino (`publishers[dest.publisher]`), não só `buffer`.
- `registerSource` está obsoleto; use `plugins.sources`. Continua funcionando.
- `kitProfileVersion` ausente conta como a versão atual, sem aviso.

### Corrigido

- A trava de escrita compara caminhos reais (symlinks resolvidos), inclusive para pastas que ainda não existem.
- A linha de falha do Buffer não repete o prefixo "Buffer:" ("o Buffer falhou (o Threads aceita...)").
