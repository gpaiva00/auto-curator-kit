import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { silentLogger } from "@auto-curator/contracts";
import { loadProfile } from "@auto-curator/engine";
import { createSources } from "@auto-curator/sources";
import { buildRuntime } from "../src/wire.js";
import { cleanEnv, REPO_PROFILES, tmpDir } from "./helpers.js";

const PROFILES = readdirSync(REPO_PROFILES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

describe("every shipped profile", () => {
  it("finds the example profiles", () => {
    expect(PROFILES).toEqual(expect.arrayContaining(["astronomia", "linkedin-exemplo", "noticias-exemplo"]));
  });

  for (const id of PROFILES) {
    it(`${id}: buildRuntime wires with Telegram and Buffer env`, () => {
      const env = cleanEnv(tmpDir(), { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOWED_CHAT_IDS: "7", BUFFER_API_KEY: "b", IMGBB_API_KEY: "i", GROQ_API_KEY: "g" });
      const rt = buildRuntime(join(REPO_PROFILES, id), env, { withTelegram: true, logger: silentLogger, telegramFetch: (async () => new Response("{}")) as typeof fetch });
      try {
        expect(rt.bot).toBeDefined();
        expect(rt.sources.length).toBeGreaterThan(0);
      } finally {
        rt.close();
      }
    });

    it(`${id}: every source validates even when forced enabled`, () => {
      const bundle = loadProfile(join(REPO_PROFILES, id), cleanEnv(tmpDir()));
      const forced = bundle.profile.sources.map((s) => ({ ...s, enabled: true }));
      const sources = createSources(forced, { env: {}, logger: silentLogger });
      expect(sources).toHaveLength(forced.length);
    });
  }
});
