import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadProfile } from "../src/index.js";
import { tmp } from "./helpers.js";

const role = { baseUrl: "https://x.test/v1", apiKeyEnv: "CHAVE_X", model: "m", inputUsdPerM: 1, outputUsdPerM: 1 };

/** Perfil mínimo num template temporário; `over` mescla no profile.json e `skip` remove arquivos obrigatórios. */
function fixture(over: Record<string, unknown> = {}, opts: { models?: unknown; skip?: string[] } = {}): string {
  const root = tmp();
  const tdir = join(root, "templates", "tt");
  mkdirSync(join(tdir, "prompts"), { recursive: true });
  writeFileSync(join(tdir, "template.json"), JSON.stringify({ name: "tt" }));
  writeFileSync(join(tdir, "models.json"), JSON.stringify(opts.models ?? { monthlyBudgetBRL: 10, roles: { triage: role, curator: role } }));
  writeFileSync(join(tdir, "prompts", "triage.md"), "p");
  writeFileSync(join(tdir, "prompts", "curator.md"), "p");
  const pdir = join(root, "perfil");
  mkdirSync(join(pdir, "prompts"), { recursive: true });
  const skip = new Set(opts.skip ?? []);
  if (!skip.has("style")) writeFileSync(join(pdir, "style-guide.md"), "guia");
  if (!skip.has("triage")) writeFileSync(join(pdir, "prompts", "triage.md"), "p");
  writeFileSync(join(pdir, "profile.json"), JSON.stringify({ id: "p1", name: "P", template: "tt", destinations: [{ platform: "x", publisher: "manual" }], ...over }));
  process.env.TEMPLATES_DIR = join(root, "templates");
  return pdir;
}

const load = (dir: string, env: NodeJS.ProcessEnv = {}) => {
  const prev = process.env.TEMPLATES_DIR;
  try {
    return loadProfile(dir, { TEMPLATES_DIR: join(dir, "..", "templates"), ...env });
  } finally {
    process.env.TEMPLATES_DIR = prev;
  }
};

describe("regras de carga do perfil (seção 4)", () => {
  it("chave desconhecida em destino é erro com caminho", () => {
    const dir = fixture({ destinations: [{ platform: "x", tipo: "buffer" }] });
    expect(() => load(dir)).toThrow(ConfigError);
    expect(() => load(dir)).toThrow(/destinations\[0\]\.tipo: chave desconhecida/);
  });
  it("chave desconhecida no nível do perfil é erro com caminho", () => {
    expect(() => load(fixture({ foo: 1 }))).toThrow(/\bfoo: chave desconhecida/);
  });
  it("chave desconhecida em models.json tem caminho", () => {
    const models = { monthlyBudgetBRL: 10, roles: { triage: { ...role, tipe: 1 }, curator: role } };
    expect(() => load(fixture({}, { models }))).toThrow(/roles\.triage\.tipe: chave desconhecida/);
  });
  it("kitProfileVersion maior que a suportada é erro", () => {
    expect(() => load(fixture({ kitProfileVersion: 2 }))).toThrow(/kitProfileVersion 2 é maior que a suportada/);
  });
  it("kitProfileVersion menor gera aviso com o link da migração, sem erro", () => {
    const b = load(fixture({ kitProfileVersion: 0 }));
    expect(b.warnings.join(" ")).toMatch(/kitProfileVersion 0 é antiga.*CHANGELOG\.md/);
  });
  it("perfil sem kitProfileVersion carrega sem aviso", () => {
    expect(load(fixture()).warnings).toEqual([]);
  });
  it("style-guide.md ausente é erro", () => {
    expect(() => load(fixture({}, { skip: ["style"] }))).toThrow(/style-guide\.md ausente/);
  });
  it("prompt ausente no perfil e no template é erro", () => {
    const pdir = fixture({}, { skip: ["triage"] });
    // o template tem triage.md; remove-o para forçar a falta nos dois lugares
    const root = join(pdir, "..");
    rmSync(join(root, "templates", "tt", "prompts", "triage.md"));
    expect(() => load(pdir)).toThrow(/prompts\/triage\.md ausente/);
  });
  it("destino com publisher de id livre é aceito na carga (checado em buildRuntime)", () => {
    expect(load(fixture({ destinations: [{ platform: "x", publisher: "meu-publisher" }] })).profile.destinations[0]!.publisher).toBe("meu-publisher");
  });
});
