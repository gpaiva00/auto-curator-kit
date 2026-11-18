import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, deepMerge, loadProfile } from "../src/index.js";
import { tmp } from "./helpers.js";

const role = { baseUrl: "https://x.test/v1", apiKeyEnv: "K", model: "m", inputUsdPerM: 1, outputUsdPerM: 1 };

describe("loadProfile", () => {
  it("merges template defaults under profile.json and loads .env without overriding", () => {
    const root = tmp();
    const tdir = join(root, "templates", "tt");
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, "template.json"), JSON.stringify({ name: "tt", draftExtraRequired: ["c"], defaults: { editorial: { credit: "hide", minConfidence: 0.7 }, pipeline: { triageMinScore: 50 } } }));
    writeFileSync(join(tdir, "models.json"), JSON.stringify({ monthlyBudgetBRL: 10, roles: { triage: role, curator: role } }));
    const pdir = join(root, "prof");
    mkdirSync(pdir);
    writeFileSync(join(pdir, "profile.json"), JSON.stringify({ id: "p1", name: "P", template: "tt", destinations: [{ platform: "x" }], editorial: { credit: "show" } }));
    writeFileSync(join(pdir, ".env"), "A=1\n# c\nexport B='two'\nKEEP=new\n");
    const env: NodeJS.ProcessEnv = { TEMPLATES_DIR: join(root, "templates"), CURADOR_DATA_DIR: join(root, "data"), KEEP: "old" };
    const b = loadProfile(pdir, env);
    expect(b.profile.editorial.credit).toBe("show");
    expect(b.profile.editorial.minConfidence).toBe(0.7);
    expect(b.profile.pipeline.triageMinScore).toBe(50);
    expect(b.template.draftExtraRequired).toEqual(["c"]);
    expect(b.dataDir).toBe(join(root, "data"));
    expect(env.A).toBe("1");
    expect(env.B).toBe("two");
    expect(env.KEEP).toBe("old");
  });

  it("explains errors in pt-BR", () => {
    const root = tmp();
    expect(() => loadProfile(join(root, "nope"), {})).toThrow(ConfigError);
    mkdirSync(join(root, "p"));
    expect(() => loadProfile(join(root, "p"), {})).toThrow(/profile\.json não encontrado/);
    writeFileSync(join(root, "p", "profile.json"), JSON.stringify({ id: "BAD ID", name: "x", template: "none" }));
    expect(() => loadProfile(join(root, "p"), { TEMPLATES_DIR: root })).toThrow(/Template/);
    expect(() => loadProfile(undefined, {})).toThrow(/CURADOR_PROFILE/);
  });

  it("deepMerge replaces arrays", () => {
    expect(deepMerge({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [3], b: { c: 9 } })).toEqual({ a: [3], b: { c: 9, d: 2 } });
  });
});

describe("real templates and profiles", () => {
  it("loads every example profile and assembles both prompts", async () => {
    const { readdirSync, existsSync } = await import("node:fs");
    const { KIT_ROOT, FilePromptProvider } = await import("../src/index.js");
    const root = join(KIT_ROOT, "profiles");
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      if (!existsSync(join(root, name, "profile.json"))) continue;
      const env: NodeJS.ProcessEnv = { CURADOR_DATA_DIR: tmp() };
      const b = loadProfile(join(root, name), env);
      const prompts = new FilePromptProvider({ profileDir: b.profileDir, templateDir: b.templateDir, profile: b.profile, draftExtraRequired: b.template.draftExtraRequired });
      for (const role of ["triage", "curator"] as const) {
        const r = prompts.get(role);
        expect(r.text).toContain("PROFILE RULES");
        expect(r.version).toMatch(new RegExp(`^${role} v`));
      }
    }
  });
});
