import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bufferIo } from "../src/io.js";
import { run } from "../src/main.js";
import { cleanEnv, REPO_PROFILES, tmpDir } from "./helpers.js";

/** Cópia do perfil de exemplo com os destinos dados, num diretório de perfis próprio. */
function perfil(destinations: unknown[], media = "none") {
  const root = tmpDir();
  const dir = join(root, "perfil");
  cpSync(join(REPO_PROFILES, "astronomia"), dir, { recursive: true, filter: (src) => !/(^|\/)\.env$/.test(src) });
  const pj = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as Record<string, any>;
  pj.destinations = destinations;
  pj.media = { ...pj.media, strategy: media };
  writeFileSync(join(dir, "profile.json"), JSON.stringify(pj));
  mkdirSync(join(dir, "data"), { recursive: true });
  return root;
}

async function doctor(root: string) {
  const io = bufferIo();
  await run(["doctor", "--offline", "--profile", "perfil"], { env: cleanEnv(tmpDir()), io, profilesRoot: root });
  return io.text();
}

describe("doctor: aviso de maxChars", () => {
  it("Threads por Buffer sem maxChars avisa que usa 500", async () => {
    const t = await doctor(perfil([{ platform: "threads", publisher: "buffer", mode: "draft", dailyCap: 4, only: "any" }]));
    expect(t).toContain("threads sem maxChars: usando 500");
  });

  it("destino com maxChars não gera aviso", async () => {
    const t = await doctor(perfil([{ platform: "threads", publisher: "buffer", mode: "draft", dailyCap: 4, only: "any", maxChars: 500 }]));
    expect(t).not.toMatch(/sem maxChars/);
  });

  it("destino que recebe mídia sem maxChars avisa que o texto não tem limite conferido", async () => {
    const t = await doctor(perfil([{ platform: "instagram", publisher: "manual", dailyCap: 4, only: "any" }], "original"));
    expect(t).toContain("instagram sem maxChars: sem limite de texto conferido");
  });
});
