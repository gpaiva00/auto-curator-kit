import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, KIT_ROOT, insideNodeModules, loadProfile } from "../src/index.js";

const tmpBases: string[] = [];
afterAll(() => tmpBases.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("perfil e dados nunca dentro de node_modules", () => {
  it("detecta qualquer segmento node_modules, de qualquer pacote", () => {
    expect(insideNodeModules("/app/node_modules/perfil-na-lib/dados")).toBe(true);
    expect(insideNodeModules("/app/node_modules/auto-curator-kit/data")).toBe(true);
    expect(insideNodeModules("/app/dados")).toBe(false);
  });
  it("resolve symlink: caminho via link que aponta para node_modules é recusado", () => {
    const base = mkdtempSync(join(tmpdir(), "ac-guard-"));
    tmpBases.push(base);
    mkdirSync(join(base, "real", "node_modules", "perfil-na-lib", "dados"), { recursive: true });
    symlinkSync(join(base, "real", "node_modules", "perfil-na-lib"), join(base, "link"));
    expect(insideNodeModules(join(base, "link", "dados"))).toBe(true);
    expect(insideNodeModules(join(base, "link"))).toBe(true);
  });
  it("no repo, o padrão <perfil>/data não é recusado", () => {
    expect(insideNodeModules(join(KIT_ROOT, "profiles/x/data"))).toBe(false);
  });
  it("sem perfil explícito, loadProfile recusa com instrução", () => {
    expect(() => loadProfile(undefined, {})).toThrow(ConfigError);
    expect(() => loadProfile(undefined, {})).toThrow(/CURADOR_PROFILE/);
  });
  it("dados padrão ficam em <perfil>/data, e CURADOR_DATA_DIR sobrescreve", () => {
    const dir = join(KIT_ROOT, "profiles", "astronomia");
    expect(loadProfile(dir, {}).dataDir).toBe(join(dir, "data"));
    expect(loadProfile(dir, { CURADOR_DATA_DIR: "/tmp/elsewhere" }).dataDir).toBe("/tmp/elsewhere");
  });
  it("loadProfile recusa dados dentro de node_modules antes de criar nada", () => {
    const dir = join(KIT_ROOT, "profiles", "astronomia");
    expect(() => loadProfile(dir, { CURADOR_DATA_DIR: join(KIT_ROOT, "node_modules", "x", "dados") })).toThrow(/node_modules/);
  });
});
