import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Logger, MediaHost, Publisher } from "@auto-curator/contracts";
import { ConfigError } from "@auto-curator/engine";
import { bufferIo } from "../src/io.js";
import { run } from "../src/main.js";
import { buildRuntime } from "../src/wire.js";
import { cleanEnv, REPO_PROFILES, tmpDir } from "./helpers.js";

const fakePub: Publisher = { name: "buffer", publish: async () => ({ externalId: "x", mode: "draft" }) };
const fakeHost: MediaHost = { name: "host", supports: () => true, upload: async () => "https://cdn.test/x.jpg" };
const captureLogger = () => {
  const info: string[] = [];
  const logger: Logger = { debug() {}, info: (m: string) => void info.push(m), warn() {}, error() {} } as unknown as Logger;
  return { logger, info };
};

describe("caminho do doctor: a mesma cadeia por papel", () => {
  it("só a chave do fallback (DeepSeek): os dois papéis ficam ok, com o provider ativo e os pulados", async () => {
    const io = bufferIo();
    await run(["doctor", "--offline", "--profile", join(REPO_PROFILES, "astronomia")], { env: cleanEnv(tmpDir(), { DEEPSEEK_API_KEY: "d" }), io });
    const t = io.text();
    expect(t).toMatch(/✅ triage: ativo deepseek\/deepseek-flash; pulados: groq \(GROQ_API_KEY ausente\)/);
    expect(t).toMatch(/✅ curator: ativo deepseek\/deepseek-flash/);
    expect(t).not.toMatch(/❌ Modelo/);
  });

  it("sem nenhuma chave: papel falha e a mensagem lista as variáveis aceitas", async () => {
    const io = bufferIo();
    await run(["doctor", "--offline", "--profile", join(REPO_PROFILES, "astronomia")], { env: cleanEnv(tmpDir()), io });
    expect(io.text()).toMatch(/❌ Modelo "triage"[^\n]*GROQ_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY/);
  });
});

describe("caminho do start (carga): a mesma cadeia, sem erro quando um provider tem chave", () => {
  it("primeiro sem chave e DeepSeek com chave: a carga passa e loga o provider ativo e os pulados", () => {
    const { logger, info } = captureLogger();
    const rt = buildRuntime(join(REPO_PROFILES, "astronomia"), cleanEnv(tmpDir(), { DEEPSEEK_API_KEY: "SEGREDO-DS" }), { logger, plugins: { publishers: { buffer: fakePub }, mediaHost: fakeHost } });
    try {
      expect(info.some((l) => l.startsWith("triage: ativo deepseek/deepseek-flash; pulados: groq (GROQ_API_KEY ausente)"))).toBe(true);
      expect(info.join("\n")).not.toContain("SEGREDO-DS"); // nenhum valor de chave no log
    } finally {
      rt.close();
    }
  });

  it("sem nenhuma chave: a carga falha com ConfigError listando as variáveis aceitas", () => {
    let err: ConfigError | undefined;
    try {
      buildRuntime(join(REPO_PROFILES, "astronomia"), cleanEnv(tmpDir()), { plugins: { publishers: { buffer: fakePub }, mediaHost: fakeHost } });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(err?.message).toMatch(/papel "triage" sem chave: defina ao menos uma destas variáveis: GROQ_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY/);
  });
});
