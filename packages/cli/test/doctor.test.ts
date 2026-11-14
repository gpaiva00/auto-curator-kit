import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bufferIo } from "../src/io.js";
import { run } from "../src/main.js";
import { cleanEnv, REPO_PROFILES, tmpDir } from "./helpers.js";

describe("doctor --offline", () => {
  it("reports ❌ for missing keys on astronomia, exits 1, does not crash", async () => {
    const io = bufferIo();
    const code = await run(["doctor", "--offline", "--profile", "astronomia"], cleanEnv(tmpDir()), io, REPO_PROFILES);
    const t = io.text();
    expect(code).toBe(1);
    expect(t).toContain("✅ profile.json válido");
    expect(t).toMatch(/❌ Chave de API para "triage"/);
    expect(t).toMatch(/❌ Chave de API para "curator"/);
    expect(t).toMatch(/❌ Telegram: TELEGRAM_BOT_TOKEN/);
    expect(t).toMatch(/❌ Buffer: BUFFER_API_KEY/);
    expect(t).toContain("Prompts presentes");
    expect(t).toMatch(/Fonte rss "NASA"/);
    expect(t).toContain("problema(s) a corrigir");
  });

  it("turns the key checks green when keys, token and chat are set (still no network)", async () => {
    const io = bufferIo();
    const env = cleanEnv(tmpDir(), { GROQ_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALLOWED_CHAT_ID: "42", BUFFER_API_KEY: "b", BUFFER_CHANNEL_INSTAGRAM: "c", IMGBB_API_KEY: "i" });
    const code = await run(["doctor", "--offline", "--profile", "astronomia"], env, io, REPO_PROFILES);
    const t = io.text();
    expect(t).toContain('✅ Chave de API para "curator": GROQ_API_KEY');
    expect(t).toContain("✅ Telegram: token definido");
    expect(t).toContain("✅ Telegram: 1 chat(s) autorizado(s)");
    expect(t).toContain("✅ Buffer: canal de instagram definido");
    expect(t).not.toContain("❌");
    expect(code).toBe(0);
  });

  it("reports an invalid profile as ❌ instead of throwing", async () => {
    const root = tmpDir();
    const dir = join(root, "quebrado");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir);
    writeFileSync(join(dir, "profile.json"), JSON.stringify({ id: "quebrado" }));
    const io = bufferIo();
    expect(await run(["doctor", "--offline", "--profile", "quebrado"], cleanEnv(tmpDir()), io, root)).toBe(1);
    expect(io.text()).toMatch(/❌ profile\.json válido/);
  });

  it("fails cleanly when no profile is given", async () => {
    const io = bufferIo();
    expect(await run(["doctor", "--offline"], cleanEnv(tmpDir()), io, REPO_PROFILES)).toBe(1);
    expect(io.text()).toContain("Perfil não informado");
  });
});
