import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, KIT_ROOT, insideInstalledKit, loadProfile } from "../src/index.js";

describe("instalação como dependência", () => {
  const installed = "/app/node_modules/auto-curator-kit";
  it("detecta alvo dentro da pasta do pacote instalado", () => {
    expect(insideInstalledKit(join(installed, "profiles/x/data"), installed)).toBe(true);
    expect(insideInstalledKit(installed, installed)).toBe(true);
    expect(insideInstalledKit("/app/data", installed)).toBe(false);
  });
  it("resolve symlink: caminho via link cai dentro da instalação real", () => {
    const base = mkdtempSync(join(tmpdir(), "ac-guard-"));
    const real = join(base, "real", "node_modules", "auto-curator-kit");
    mkdirSync(real, { recursive: true });
    const link = join(base, "link");
    symlinkSync(join(base, "real"), link);
    expect(insideInstalledKit(join(link, "node_modules", "auto-curator-kit", "data"), real)).toBe(true);
  });
  it("no repo (fora de node_modules) nunca bloqueia", () => {
    expect(insideInstalledKit(join(KIT_ROOT, "profiles/x/data"), KIT_ROOT)).toBe(false);
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
});
