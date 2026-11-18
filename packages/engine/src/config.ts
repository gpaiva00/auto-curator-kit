import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { KIT_PROFILE_VERSION, KitError, ModelsConfig, ProfileConfig, TemplateConfig } from "@auto-curator/contracts";
import { formatIssuePath, ptErrorMap } from "@auto-curator/contracts/errors-pt";
import { kitRoot } from "@auto-curator/contracts/kit-root";

export class ConfigError extends KitError {
  constructor(message: string) {
    super(message, "CONFIG");
    this.name = "ConfigError";
  }
}

/** Raiz do kit: repo no desenvolvimento, pacote instalado em node_modules no consumidor. */
export const KIT_ROOT = kitRoot();

export interface ProfileBundle {
  profile: ProfileConfig;
  template: TemplateConfig;
  templateDir: string;
  models: ModelsConfig;
  profileDir: string;
  dataDir: string;
  /** Avisos que não impedem a carga (ex.: kitProfileVersion antiga). */
  warnings: string[];
}

export const MIGRATION_URL = "https://github.com/gpaiva00/auto-curator-kit/blob/main/CHANGELOG.md";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Objects merge recursively; arrays and scalars from `over` replace `base`. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

/** Minimal .env parser: KEY=VALUE, `#` comments, optional quotes, optional `export `. Never overrides existing env. */
export function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(file)) return [];
  const set: string[] = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (env[m[1]!] === undefined) {
      env[m[1]!] = v;
      set.push(m[1]!);
    }
  }
  return set;
}

function readJson(file: string, what: string): unknown {
  if (!existsSync(file)) throw new ConfigError(`${what} não encontrado: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`${what} com JSON inválido (${file}): ${(e as Error).message}`);
  }
}

function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown, what: string, file: string): T {
  const r = schema.safeParse(data, { errorMap: ptErrorMap });
  if (r.success) return r.data;
  // chave desconhecida vira uma linha por chave, com o nome no caminho (sources[2].tipe)
  const issues = r.error.issues
    .flatMap((i) => (i.code === "unrecognized_keys" ? i.keys.map((k) => `  - ${formatIssuePath([...i.path, k])}: chave desconhecida`) : [`  - ${formatIssuePath(i.path) || "(raiz)"}: ${i.message}`]))
    .join("\n");
  throw new ConfigError(`${what} inválido (${file}):\n${issues}`);
}

/** Profile dir from an explicit argument, else CURADOR_PROFILE. */
export function resolveProfileDir(arg: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const dir = arg ?? env.CURADOR_PROFILE;
  if (!dir) throw new ConfigError("Perfil não informado: passe o diretório do perfil ou defina CURADOR_PROFILE.");
  return resolve(dir);
}

/** Caminho com symlinks resolvidos; se o fim ainda não existe, resolve a parte que existe. */
function realPath(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
}

/** O caminho real (symlinks resolvidos) passa por node_modules: pacote instalado, nunca perfil nem dados. */
export function insideNodeModules(target: string): boolean {
  return realPath(target).split(/[\\/]/).includes("node_modules");
}

export function templatesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEMPLATES_DIR ? resolve(env.TEMPLATES_DIR) : join(KIT_ROOT, "templates");
}

/** Loads a profile: its .env, profile.json merged over template defaults, the template and models.json. */
export function loadProfile(profileDirArg?: string, env: NodeJS.ProcessEnv = process.env): ProfileBundle {
  const profileDir = resolveProfileDir(profileDirArg, env);
  if (!existsSync(profileDir)) throw new ConfigError(`Diretório do perfil não existe: ${profileDir}`);
  loadDotEnv(join(profileDir, ".env"), env);

  const profileFile = join(profileDir, "profile.json");
  const rawProfile = readJson(profileFile, "profile.json");
  if (!isObj(rawProfile)) throw new ConfigError(`profile.json deve ser um objeto (${profileFile})`);

  const templateName = typeof rawProfile.template === "string" ? rawProfile.template : "thought-leader";
  const templateDir = join(templatesRoot(env), templateName);
  if (!existsSync(templateDir)) throw new ConfigError(`Template "${templateName}" não encontrado em ${templateDir} (perfil ${profileFile}).`);
  const templateFile = join(templateDir, "template.json");
  const template = parseWith(TemplateConfig, readJson(templateFile, "template.json"), "template.json", templateFile);

  const merged = deepMerge(template.defaults, rawProfile);
  const profile = parseWith(ProfileConfig, merged, "profile.json", profileFile);

  const warnings: string[] = [];
  const version = profile.kitProfileVersion ?? KIT_PROFILE_VERSION;
  if (version > KIT_PROFILE_VERSION) throw new ConfigError(`profile.json: kitProfileVersion ${version} é maior que a suportada pelo kit (${KIT_PROFILE_VERSION}). Atualize o auto-curator-kit.`);
  if (version < KIT_PROFILE_VERSION) warnings.push(`profile.json: kitProfileVersion ${version} é antiga (atual: ${KIT_PROFILE_VERSION}). Veja como migrar em ${MIGRATION_URL}`);

  const styleFile = join(profileDir, "style-guide.md");
  if (!existsSync(styleFile)) throw new ConfigError(`style-guide.md ausente em ${profileDir} (voz, público e assuntos do perfil).`);
  for (const role of ["triage", "curator"] as const) {
    const own = join(profileDir, "prompts", `${role}.md`);
    const shared = join(templatesRoot(env), templateName, "prompts", `${role}.md`);
    if (!existsSync(own) && !existsSync(shared)) throw new ConfigError(`prompts/${role}.md ausente: crie no perfil (${own}) ou use um template que o tenha.`);
  }

  const modelsFile = profile.models === "default" ? join(templateDir, "models.json") : isAbsolute(profile.models) ? profile.models : join(profileDir, profile.models);
  const models = parseWith(ModelsConfig, readJson(modelsFile, "models.json"), "models.json", modelsFile);

  if (insideNodeModules(profileDir)) throw new ConfigError("O perfil está dentro de node_modules. Copie-o para uma pasta sua e aponte --profile para ela.");
  const dataDir = resolve(env.CURADOR_DATA_DIR ?? join(profileDir, "data"));
  if (insideNodeModules(dataDir)) throw new ConfigError("Os dados ficariam dentro de node_modules. Defina CURADOR_DATA_DIR com uma pasta fora dela.");
  return { profile, template, templateDir, models, profileDir, dataDir, warnings };
}
