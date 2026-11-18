import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile } from "@auto-curator/engine";
import { run } from "../src/main.js";
import { bufferIo } from "../src/io.js";
import { cleanEnv, tmpDir } from "./helpers.js";

describe("create", () => {
  it.each(["news-card", "thought-leader"])("scaffolds a profile that loads (%s)", async (template) => {
    const root = tmpDir();
    const io = bufferIo();
    const code = await run(["create", "meu-perfil", "--template", template, "--name", "Meu Perfil"], { env: cleanEnv(tmpDir()), io: io, profilesRoot: root });
    expect(code).toBe(0);
    const dir = join(root, "meu-perfil");
    for (const f of ["profile.json", "style-guide.md", ".env.example", "evals/cases.json"]) expect(existsSync(join(dir, f))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "evals/cases.json"), "utf8"))).toEqual([]);
    expect(readFileSync(join(dir, "style-guide.md"), "utf8")).toContain("## Voz");
    const env = cleanEnv(tmpDir());
    const b = loadProfile(dir, env);
    expect(b.profile.id).toBe("meu-perfil");
    expect(b.profile.name).toBe("Meu Perfil");
    expect(b.template.name).toBe(template);
    const text = io.text();
    expect(text).toContain("BotFather");
    expect(text).toContain("doctor --profile meu-perfil");
    expect(text).toContain("start --profile meu-perfil");
  });

  it("derives the name from the id and defaults to news-card", async () => {
    const root = tmpDir();
    expect(await run(["create", "ceu-de-hoje"], { env: cleanEnv(tmpDir()), io: bufferIo(), profilesRoot: root })).toBe(0);
    const p = JSON.parse(readFileSync(join(root, "ceu-de-hoje/profile.json"), "utf8"));
    expect(p).toMatchObject({ name: "Ceu De Hoje", template: "news-card" });
  });

  it("refuses to overwrite an existing dir", async () => {
    const root = tmpDir();
    mkdirSync(join(root, "ja-existe"));
    const io = bufferIo();
    expect(await run(["create", "ja-existe"], { env: cleanEnv(tmpDir()), io: io, profilesRoot: root })).toBe(1);
    expect(io.text()).toContain("já existe");
    expect(existsSync(join(root, "ja-existe", "profile.json"))).toBe(false);
  });

  it("rejects bad ids and unknown templates without writing anything", async () => {
    const root = tmpDir();
    const io = bufferIo();
    expect(await run(["create", "Nome Ruim"], { env: cleanEnv(tmpDir()), io: io, profilesRoot: root })).toBe(1);
    expect(await run(["create", "ok", "--template", "nao-existe"], { env: cleanEnv(tmpDir()), io: io, profilesRoot: root })).toBe(1);
    expect(io.text()).toContain("news-card");
    expect(existsSync(join(root, "ok"))).toBe(false);
  });
});
