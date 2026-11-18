import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { KitError, ModelsConfig, ProfileConfig, TemplateConfig } from "@auto-curator/contracts";
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
}

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
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`).join("\n");
  throw new ConfigError(`${what} inválido (${file}):\n${issues}`);
}

/** Profile dir from an explicit argument, else CURADOR_PROFILE. */
export function resolveProfileDir(arg: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const dir = arg ?? env.CURADOR_PROFILE;
  if (!dir) throw new ConfigError("Perfil não informado: passe o diretório do perfil ou defina CURADOR_PROFILE.");
  return resolve(dir);
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

  const modelsFile = profile.models === "default" ? join(templateDir, "models.json") : isAbsolute(profile.models) ? profile.models : join(profileDir, profile.models);
  const models = parseWith(ModelsConfig, readJson(modelsFile, "models.json"), "models.json", modelsFile);

  const dataDir = resolve(env.CURADOR_DATA_DIR ?? join(KIT_ROOT, "data", profile.id));
  return { profile, template, templateDir, models, profileDir, dataDir };
}
