import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isInstalledKit } from "@auto-curator/contracts/kit-root";
import { ConfigError, KIT_ROOT } from "@auto-curator/engine";

/** PROFILES_DIR; no repo, profiles/. Instalado como dependência, sem PROFILES_DIR não há raiz (busca por id desligada). */
export const defaultProfilesRoot = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env.PROFILES_DIR ? resolve(env.PROFILES_DIR) : isInstalledKit() ? undefined : join(KIT_ROOT, "profiles");

/** Ids (folders with a profile.json) under a profiles root. */
export function listProfileIds(root: string | undefined): string[] {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "profile.json")))
    .map((d) => d.name)
    .sort();
}

const looksLikePath = (v: string): boolean => isAbsolute(v) || v.startsWith(".") || v.includes("/") || v.includes("\\");

/**
 * Profile directory from `--profile` (a path, or an id under profiles/), else CURADOR_PROFILE (same rules).
 * Throws ConfigError with the available ids when nothing matches.
 */
export function resolveProfile(arg: string | undefined, env: NodeJS.ProcessEnv = process.env, profilesRoot: string | undefined = defaultProfilesRoot(env)): string {
  const value = (arg ?? env.CURADOR_PROFILE)?.trim();
  const available = () => {
    if (!profilesRoot) return " Para usar o id, defina PROFILES_DIR com a pasta dos perfis (ou informe o caminho do perfil).";
    const ids = listProfileIds(profilesRoot);
    return ids.length ? ` Perfis disponíveis em ${profilesRoot}: ${ids.join(", ")}.` : ` Nenhum perfil encontrado em ${profilesRoot}.`;
  };
  if (!value) throw new ConfigError(`Perfil não informado: use --profile <id ou diretório> ou defina CURADOR_PROFILE.${available()}`);

  const repoRelative = isInstalledKit() ? [] : [resolve(KIT_ROOT, value)];
  const candidates = looksLikePath(value) ? [resolve(value), ...repoRelative] : [...(profilesRoot ? [join(profilesRoot, value)] : []), resolve(value)];
  for (const c of candidates) if (existsSync(join(c, "profile.json"))) return c;
  throw new ConfigError(`Perfil "${value}" não encontrado (procurei ${candidates.join(" e ")}).${available()}`);
}
