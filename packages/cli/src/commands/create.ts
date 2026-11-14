import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProfileConfig, TemplateConfig } from "@auto-curator/contracts";
import { ConfigError, deepMerge, templatesRoot } from "@auto-curator/engine";
import { defaultProfilesRoot } from "../profile.js";
import type { CmdCtx } from "../io.js";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const TEMPLATE_PLATFORM: Record<string, { platform: string; composeUrl?: string; handle: string }> = {
  "news-card": { platform: "instagram", handle: "@seuperfil" },
  "thought-leader": { platform: "linkedin", composeUrl: "https://www.linkedin.com/feed/?shareActive=true", handle: "" },
};

export function listTemplates(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "template.json")))
    .map((d) => d.name)
    .sort();
}

/** "meu-perfil" -> "Meu Perfil". */
export const titleFromId = (id: string): string => id.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

export function profileJsonFor(id: string, name: string, template: string): Record<string, unknown> {
  const t = TEMPLATE_PLATFORM[template] ?? { platform: "instagram", handle: "" };
  const destination: Record<string, unknown> = { platform: t.platform, publisher: "manual", mode: "draft", dailyCap: 4 };
  if (t.composeUrl) destination.composeUrl = t.composeUrl;
  const out: Record<string, unknown> = {
    id,
    name,
    template,
    language: "pt-BR",
    timezone: "America/Sao_Paulo",
    sources: [
      { type: "rss", name: "Exemplo (troque a URL e ative)", url: "https://example.com/feed.xml", enabled: false },
      { type: "manual" },
    ],
    destinations: [destination],
  };
  if (template === "news-card") out.brand = { name, handle: t.handle, colors: { primary: "#4A22E8", accent: "#FF5A6E", background: "#FFFFFF", text: "#111111" }, fontFamily: "Inter" };
  out.telegram = { rejectReasons: "default" };
  out.models = "default";
  return out;
}

export function styleGuideSkeleton(name: string, template: string): string {
  if (template === "thought-leader") {
    return `# Guia de estilo: ${name} (preencher)

> O Curador lê este arquivo a cada execução. Quanto mais concreto, melhor o texto. Troque tudo que estiver entre parênteses.

## Quem eu sou
(preencher: cargo, área, o que você vende ou defende, em 2 ou 3 linhas)

## Público
(preencher: quem lê, o que essa pessoa quer aprender ou decidir)

## Assuntos que eu comento
(preencher: lista de temas dentro do seu território)

## Assuntos que eu nunca comento
(preencher: política partidária, empresas em que você trabalhou, qualquer coisa confidencial)

## Voz
(preencher: tom, pessoa gramatical, palavras que você usa e as que evita)

## Estrutura dos posts
(preencher: gancho na primeira linha, quantos parágrafos, como termina)

## Exemplos de posts meus que eu gosto
(preencher: cole 2 ou 3 posts reais)

## Nunca
(preencher: lista curta de proibições)
`;
  }
  return `# Guia de estilo: ${name} (preencher)

> O Curador lê este arquivo a cada execução. Quanto mais concreto, melhor o texto. Troque tudo que estiver entre parênteses.

## Quem somos
(preencher: nicho, público e promessa do perfil, em 2 ou 3 linhas)

## Dentro do nicho
(preencher: assuntos que entram)

## Fora do nicho (skip)
(preencher: assuntos que devem ser descartados com o motivo "fora do nicho")

## Assuntos arriscados
(preencher: o que deve ir para revisão humana e com qual flag)

## Voz
(preencher: tom, vocabulário, o que evitar)

## Gancho (\`extra.categoryTag\`)
(preencher: 2 a 5 palavras em CAIXA ALTA, com exemplos do seu nicho)

## Headline (\`headline\`)
(preencher: tamanho, estilo, exemplos de bom e ruim)

## Legenda (\`body\`)
(preencher: estrutura, chamada para comentário)

## Crédito (\`sourceCredit\`)
(preencher: como creditar a fonte)

## Hashtags
(preencher: quantas, quais famílias)

## Mídia
(preencher: quando usar imagem, quando usar vídeo)

## Quando mandar para o humano
(preencher: situações que exigem revisão)
`;
}

export function envExampleFor(template: string, destination: string): string {
  const plat = destination.toUpperCase();
  const browser = template === "thought-leader";
  return `# Copie para .env e preencha. Nunca commite o .env com valores reais.

# --- Telegram (um bot por perfil, criado no @BotFather) ---
TELEGRAM_BOT_TOKEN=
# Ids dos chats autorizados a aprovar, separados por vírgula (use @userinfobot para descobrir o seu)
TELEGRAM_ALLOWED_CHAT_IDS=

# --- LLM (basta uma chave para começar; as demais viram fallback em caso de 402/429/5xx) ---
GROQ_API_KEY=
DEEPSEEK_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=

# --- Buffer (opcional: sem ele você publica à mão a partir do Telegram) ---
# Para usar, troque "publisher": "manual" por "buffer" no destino do profile.json
BUFFER_API_KEY=
BUFFER_CHANNEL_${plat}=

# --- Hospedagem de mídia para o Buffer (opcional: escolha uma) ---
IMGBB_API_KEY=
# R2_ACCOUNT_ID=
# R2_ACCESS_KEY_ID=
# R2_SECRET_ACCESS_KEY=
# R2_BUCKET=
# R2_PUBLIC_URL=
${browser ? "\n# --- Chrome dedicado via CDP (só para fontes de navegador, como x-feed) ---\nBROWSER_CDP_URL=http://127.0.0.1:9222\n" : ""}
# --- Pastas e log ---
# CURADOR_DATA_DIR=data/<id>
LOG_LEVEL=info
`;
}

export interface CreateOptions {
  id: string;
  template?: string;
  name?: string;
  profilesRoot: string;
  templatesRoot: string;
}

/** Writes profiles/<id>/. Throws ConfigError (id invalid, template unknown, dir exists). Returns the created dir. */
export function scaffoldProfile(o: CreateOptions): { dir: string; files: string[]; template: string; name: string } {
  if (!ID_RE.test(o.id)) throw new ConfigError(`Id inválido: "${o.id}". Use letras minúsculas, números e hífen (ex.: astronomia, meu-linkedin).`);
  const template = o.template ?? "news-card";
  const available = listTemplates(o.templatesRoot);
  if (!available.includes(template)) throw new ConfigError(`Template "${template}" não existe em ${o.templatesRoot}. Disponíveis: ${available.join(", ") || "(nenhum)"}.`);
  const dir = join(o.profilesRoot, o.id);
  if (existsSync(dir)) throw new ConfigError(`${dir} já existe; não vou sobrescrever. Escolha outro id ou apague a pasta.`);

  const name = o.name?.trim() || titleFromId(o.id);
  const profile = profileJsonFor(o.id, name, template);

  // fail before writing anything if the result would not load
  const tpl = TemplateConfig.parse(JSON.parse(readFileSync(join(o.templatesRoot, template, "template.json"), "utf8")));
  ProfileConfig.parse(deepMerge(tpl.defaults, profile));

  mkdirSync(join(dir, "evals"), { recursive: true });
  const dest = (profile.destinations as { platform: string }[])[0]!.platform;
  const files: Record<string, string> = {
    "profile.json": JSON.stringify(profile, null, 2) + "\n",
    "style-guide.md": styleGuideSkeleton(name, template),
    ".env.example": envExampleFor(template, dest),
    "evals/cases.json": "[]\n",
  };
  for (const [f, content] of Object.entries(files)) writeFileSync(join(dir, f), content, { flag: "wx" });
  return { dir, files: Object.keys(files), template, name };
}

export async function createCommand(ctx: CmdCtx): Promise<number> {
  const id = ctx.args.positionals[0];
  if (!id) {
    ctx.io.err("Uso: create <id> [--template news-card|thought-leader] [--name \"Nome do perfil\"]");
    return 1;
  }
  const profilesRoot = ctx.profilesRoot ?? defaultProfilesRoot(ctx.env);
  const r = scaffoldProfile({ id, template: ctx.args.template, name: ctx.args.name, profilesRoot, templatesRoot: templatesRoot(ctx.env) });
  const o = ctx.io.out;
  o(`✅ Perfil "${r.name}" criado em ${r.dir}`);
  for (const f of r.files) o(`   • ${f}`);
  o();
  o("Próximos passos:");
  o(`  1. Edite ${join(r.dir, "profile.json")} (fontes e destinos) e preencha ${join(r.dir, "style-guide.md")}.`);
  o("  2. Crie o bot no Telegram: abra @BotFather, envie /newbot e guarde o token. Descubra seu chat id com @userinfobot.");
  o(`  3. Copie ${join(r.dir, ".env.example")} para ${join(r.dir, ".env")} e preencha o token, o chat id e ao menos uma chave de LLM.`);
  o(`  4. bun run doctor --profile ${id}     (confere tudo; ❌ precisa ser corrigido)`);
  o(`  5. bun run scan --profile ${id}       (lê as fontes uma vez, sem IA)`);
  o(`  6. bun run eval --profile ${id}       (opcional: casos de regressão do Curador; preencha evals/cases.json)`);
  o(`  7. bun run start --profile ${id}      (liga o bot e o agendador)`);
  return 0;
}
