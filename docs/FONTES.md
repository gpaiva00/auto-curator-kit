# Fontes

Uma fonte é uma entrada de `sources` no `profile.json`. Ela tem um `type` (qual plugin), um `name` opcional (aparece nas mensagens e nos logs) e `enabled` (padrão `true`; `false` pula a fonte sem removê-la). O restante são as opções do tipo.

As opções são validadas com schema **estrito**: uma chave desconhecida faz a fonte falhar com `opção desconhecida: <chave>`. O `doctor` mostra a falha por fonte.

## Regras comuns

Valem para todos os tipos, aplicadas pelo motor (`packages/engine/src/jobs.ts`):

1. **Deduplicação.** A chave `dedupeKey` de cada item é transformada em hash SHA-256 e guardada com `UNIQUE`. Um item já visto nunca entra de novo, mesmo que a fonte o devolva outra vez.
2. **Pré-filtro sem IA**, para itens que não são `manual`:
   - casa `editorial.blockedPatterns` → `skipped`;
   - `postedAt` mais antigo que `pipeline.maxItemAgeHours` → `skipped`.
3. **Teto por fonte.** Os itens que sobram são ordenados por engajamento (curtidas + 2 × comentários + 3 × compartilhamentos). Só os `pipeline.maxNewPerSource` primeiros entram; o resto vai para `skipped`.
4. **Triagem.** Itens de origem `feed` passam pela triagem (IA barata). Itens `manual` e `profile` vão direto para a curadoria, com nota 100 (manual) ou sem nota.
5. Fontes são lidas pelo job `ingest`, a cada `pipeline.intervalsMinutes.ingest` minutos. Falha em uma fonte não derruba as outras.

Use `bun run scan --profile <id>` para ver o que cada fonte devolve e por que cada item seria filtrado, sem gastar IA.

## Tipos embutidos

| Tipo | Lê de | Para que serve | Acesso |
|---|---|---|---|
| `rss` | feed RSS 2.0, RSS 1.0 ou Atom | Sites, blogs, releases | HTTP |
| `google-news` | Google Notícias, por busca | Palavras-chave | HTTP |
| `google-trends` | Google Trends (assuntos em alta) | Radar de temas por país | HTTP |
| `manual` | `/add` no Telegram | Links e textos que você envia | HTTP (para ler a página) |
| `x-feed` | Linha do tempo do X | Leitura de posts | Chrome dedicado (navegador) |
| `instagram-profile` | Posts de perfis do Instagram | Leitura de posts | Chrome dedicado (navegador) |

### rss

Lê um feed. Itens sem título ou sem link `http(s)` são descartados.

| Opção | Padrão | Limites | Notas |
|---|---|---|---|
| `url` | obrig. | `http://` ou `https://` | Endereço do feed. |
| `maxItems` | `20` | 1 a 200 | Quantos itens do topo do feed considerar. |
| `fetchImage` | `true` | | Se o feed não traz imagem, busca `og:image` nas páginas (até 4 em paralelo). |
| `timeoutSeconds` | `15` | até 120 | Tempo limite do download do feed. |
| `name` | nome do host | | |

- **Chave de deduplicação:** `rss:<link canônico>`.
- Origem: `feed`.

```json
{ "type": "rss", "name": "Blog do projeto", "url": "https://example.com/feed.xml", "maxItems": 15 }
```

### google-news

Busca no Google Notícias e lê o feed de resultados (`news.google.com/rss/search`).

| Opção | Padrão | Limites | Notas |
|---|---|---|---|
| `query` | obrig. | texto não vazio | Aceita operadores como `OR`, aspas e `when:2d`. |
| `hl` | `pt-BR` | mín. 2 caracteres | Idioma da interface do Google. |
| `gl` | `BR` | 2 letras | País. |
| `ceid` | `BR:pt-419` | mín. 3 caracteres | Edição do Google Notícias. |
| `maxItems` | `15` | 1 a 100 | |
| `fetchImage` | `true` | | Igual ao `rss`. Também resolve o link para o site de origem. |
| `timeoutSeconds` | `15` | até 120 | |
| `name` | `Google News: <query>` | | |

- **Chave de deduplicação:** `rss:<link canônico>` (mesmo formato do `rss`).
- Origem: `feed`.

```json
{
  "type": "google-news",
  "name": "Google News: astronomia (pt-BR)",
  "query": "astronomia OR \"James Webb\" OR eclipse when:2d",
  "hl": "pt-BR",
  "gl": "BR",
  "ceid": "BR:pt-419",
  "maxItems": 15
}
```

### google-trends

Lê o RSS de "em alta agora" do Google Trends para um país, com as notícias relacionadas a cada assunto. Ordena pelo tráfego aproximado.

| Opção | Padrão | Limites | Notas |
|---|---|---|---|
| `geo` | `BR` | `XX` ou `XX-YYY` | Código do país (ex.: `BR`, `US`, `PT`). |
| `maxItems` | `20` | 1 a 100 | |
| `minTraffic` | `0` | ≥ 0 | Descarta assuntos com tráfego aproximado abaixo disso (ex.: `1000` para mil buscas). |
| `timeoutSeconds` | `20` | até 120 | |
| `name` | `Google Trends <GEO>` | | |

- **Chave de deduplicação:** `trend:<GEO>:<nome sem acento>:<AAAA-MM-DD>`. O mesmo assunto volta a ser aceito no dia seguinte.
- Origem: `feed`. O texto do item traz o assunto e as manchetes relacionadas.

```json
{ "type": "google-trends", "geo": "BR", "maxItems": 10, "minTraffic": 5000 }
```

### manual

Não tem leitura periódica (`fetch` devolve vazio). Atende o `/add` do Telegram.

| Opção | Padrão | Limites |
|---|---|---|
| `timeoutSeconds` | `15` | até 120 |
| `name` | `manual` | |

Comportamento de `/add <entrada>`:

- **Link `http(s)`:** lê a página (título, descrição, corpo, imagem, autor e data quando existirem). Se você colou texto junto com o link, esse texto vira o texto do item. Se a página não puder ser lida, o item é criado só com o link e o texto colado.
- **Link de X ou de Instagram:** recusado por esta fonte, porque precisa das fontes de navegador (`x-feed` e `instagram-profile`), que o motor consulta antes.
- **Texto livre:** vira um item com chave `manual:<hash do texto>`. Enviar o mesmo texto de novo é ignorado.
- Origem: `manual`. Itens manuais pulam a triagem e têm nota 100.
- Esta fonte é sempre consultada por último, para que as outras fontes reclamem a entrada antes.

```json
{ "type": "manual" }
```

### x-feed (navegador)

Lê a linha do tempo do X pelo Chrome dedicado (ver [DEPLOY.md](DEPLOY.md#3-chrome-dedicado-scriptschrome-readersh)). Também resolve links de status (`x.com/<usuario>/status/<id>`) enviados com `/add`, incluindo a continuação do mesmo autor (thread).

> **Uso sujeito aos Termos do X.** Use uma conta secundária de leitura. Mantenha o volume baixo.

| Opção | Padrão | Limites | Notas |
|---|---|---|---|
| `feed` | obrig. | `following` ou `for_you` | Aba da linha do tempo. |
| `ownHandle` | — | | Seu próprio usuário, sem `@`. Posts seus são descartados. |
| `includeReplies` | `false` | | Inclui respostas. |
| `minChars` | `120` | ≥ 0 | Posts mais curtos são descartados. |
| `minLikes` | `0` | ≥ 0 | Curtidas mínimas. |
| `maxPerScan` | `15` | 1 a 100 | Máximo de posts aceitos por leitura. A leitura olha até `maxPerScan × 3` (no máximo 60) posts. |
| `limits.minDelaySeconds` | `20` | ≥ 0 | Intervalo mínimo entre duas leituras de página. |
| `limits.maxPerHour` | `20` | ≥ 1 | Teto de leituras por hora. |
| `limits.cooldownMinutes` | `60` | ≥ 0 | Pausa depois de um sinal de bloqueio ou de pedido de login. |
| `name` | `x-feed` | | |

- **Chave de deduplicação:** `x:<id do post>`.
- Origem: `feed`. Posts patrocinados são descartados.
- Erros de login, desafio ou ritmo viram `BrowserError`. Aparecem no `scan` e nos logs da ingestão (o `doctor` só monta a fonte, sem lê-la). Login ou desafio exigem resolver a tela no Chrome dedicado.

```json
{
  "type": "x-feed",
  "name": "Feed do X (Para você)",
  "feed": "for_you",
  "ownHandle": "seu_usuario",
  "includeReplies": false,
  "minChars": 120,
  "minLikes": 0,
  "maxPerScan": 15,
  "limits": { "minDelaySeconds": 20, "maxPerHour": 20, "cooldownMinutes": 60 }
}
```

> **Atenção:** opções desconhecidas fazem a fonte falhar (o schema é estrito). Os limites ficam dentro de `limits`, e o teto é `maxPerScan`.

### instagram-profile (navegador)

Lê os posts mais recentes de perfis públicos do Instagram pelo Chrome dedicado. Também resolve links de post (`instagram.com/p/…`, `/reel/…`, `/tv/…`) enviados com `/add`.

> **Uso sujeito aos Termos do Instagram.** Use uma conta secundária de leitura. Mantenha o volume baixo.

| Opção | Padrão | Limites | Notas |
|---|---|---|---|
| `handles` | obrig. | lista com ao menos 1 | Usuários sem `@`, até 30 caracteres `[A-Za-z0-9._]`. |
| `role` | — | `outlet` ou `subject` | Vai para `extra.role` do item (o Curador usa como contexto). |
| `postsPerHandle` | `3` | 1 a 12 | Posts novos lidos por perfil a cada leitura. |
| `limits.minDelaySeconds` | `20` | ≥ 0 | |
| `limits.maxPerHour` | `40` | ≥ 1 | |
| `limits.cooldownMinutes` | `60` | ≥ 0 | |
| `name` | `instagram-profile` | | |

- **Primeiro contato** com um perfil: os posts que já estão na grade são marcados como vistos e **não** são lidos. Assim você não recebe o acervo antigo.
- Depois, só posts novos (até `postsPerHandle`) são lidos. O motor guarda os últimos 150 códigos vistos por perfil.
- **Chave de deduplicação:** `ig:<código do post>`.
- Origem: `profile` (lista automática) ou `manual` (`/add`).
- Tela de login ou de confirmação de idade vira `AUTH_REQUIRED`: resolva no Chrome dedicado.

```json
{
  "type": "instagram-profile",
  "name": "Perfis de referência (navegador)",
  "handles": ["perfil_publico_exemplo_1", "perfil_publico_exemplo_2"],
  "postsPerHandle": 5,
  "limits": { "minDelaySeconds": 20, "maxPerHour": 40, "cooldownMinutes": 60 },
  "enabled": false
}
```

> **Atenção:** o nome da opção é `postsPerHandle`; opções desconhecidas fazem a fonte falhar.

## Fontes que existem no código, mas não são tipos

- `google-trends`, `google-news` e `rss` compartilham o mesmo leitor de feeds (`FeedSource`).
- `x-feed` e `instagram-profile` compartilham o leitor de navegador (`openBrowser`, com o limitador de ritmo).

## Escrever uma fonte nova

Uma fonte implementa a interface `Source` de `@auto-curator/contracts`:

```ts
interface Source {
  readonly type: string;                 // o valor de "type" no profile.json
  readonly name: string;                 // aparece nas mensagens e nos logs
  fetch(ctx: SourceContext): Promise<RawItem[]>;        // leitura periódica; nunca chama LLM
  fromInput?(input: string, ctx: SourceContext): Promise<RawItem | undefined>; // opcional: /add
}
```

`SourceContext` traz `now`, `profile`, `dataDir`, `env`, `logger` e `state` (um pequeno armazenamento chave-valor, isolado por fonte, para cursores e "já vi"). `RawItem` é o formato do item: `dedupeKey` (obrigatória e estável), `origin` (`feed`, `profile` ou `manual`), `source`, `text`, e opcionais `sourceUrl`, `author`, `title`, `media`, `postedAt`, `engagement` e `extra`. O schema completo está em `packages/contracts/src/item.ts`.

Regras:

- `dedupeKey` precisa ser **estável**: o mesmo conteúdo sempre gera a mesma chave. Use um id do provedor ou a URL canônica, com um prefixo do tipo (`minha-fonte:<id>`).
- `fetch` não chama IA e deve ser barato. Trate erros lançando exceção: o motor registra e segue com as outras fontes.
- Valide as opções no construtor e lance erro em caso de configuração inválida. As fontes embutidas usam o schema estrito do zod, para o `doctor` acusar a chave errada.

### Registrar a fonte

`registerSource(type, factory, { description?, override? })` fica em `@auto-curator/sources`. A `factory` recebe a entrada do `profile.json` e `{ env, logger }`:

```ts
import { registerSource } from "@auto-curator/sources";
import { run } from "@auto-curator/cli";
import type { RawItem, Source, SourceConfig, SourceContext } from "@auto-curator/contracts";
import { z } from "zod";

const Opts = z
  .object({
    type: z.string(),
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    url: z.string().url(),
    maxItems: z.number().int().min(1).max(50).default(10),
  })
  .strict();

class JsonFeedSource implements Source {
  readonly type = "json-feed";
  readonly name: string;
  constructor(private readonly o: z.infer<typeof Opts>) {
    this.name = o.name ?? "json-feed";
  }
  async fetch(_ctx: SourceContext): Promise<RawItem[]> {
    const res = await fetch(this.o.url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${this.o.url}`);
    const rows = (await res.json()) as { id: string; title: string; link: string; body?: string; author?: string; date?: string }[];
    return rows.slice(0, this.o.maxItems).map((r) => ({
      dedupeKey: `json-feed:${r.id}`,
      origin: "feed",
      source: this.name,
      sourceUrl: r.link,
      author: r.author ?? "",
      title: r.title,
      text: r.body ?? r.title,
      media: [],
      postedAt: r.date,
      engagement: {},
      extra: {},
    }));
  }
}

registerSource("json-feed", (cfg: SourceConfig) => new JsonFeedSource(Opts.parse(cfg)), {
  description: "Feed JSON próprio (opções: url, maxItems).",
});

process.exitCode = await run(process.argv.slice(2));
```

Pontos importantes:

- Um tipo não pode repetir um embutido nem outro plugin, a menos que `override: true`. O nome precisa casar com `^[a-z][a-z0-9-]{0,40}$`.
- **O registro vale só no processo em que foi feito.** O CLI do repositório (`packages/cli/src/main.ts`) não carrega plugins de arquivo. Para usar a fonte, rode o comando por um entrypoint seu, como o acima, que registra o plugin e então chama `run` de `@auto-curator/cli`. Sem isso, `doctor` e `start` respondem `Tipo de fonte desconhecido`.
- Não há carga automática por `profile.json`. Isso é intencional: o registro é explícito e testável.
- Para os testes, `packages/sources/test/registry.test.ts` mostra o padrão de registrar e remover um plugin (`unregisterSource`).
