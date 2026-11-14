import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { silentLogger } from "@auto-curator/contracts";
import { AlreadyRunningError, acquireLock } from "../src/lock.js";
import { parseCommandLine } from "../src/args.js";
import { buildRuntime, parseChatIds, parseUserIds } from "../src/wire.js";
import { cleanEnv, REPO_PROFILES, tmpDir } from "./helpers.js";

describe("parseChatIds", () => {
  it("accepts a comma list, the legacy singular var, and ignores blanks/duplicates", () => {
    expect(parseChatIds({ TELEGRAM_ALLOWED_CHAT_IDS: "1, 2,,3 ,1" })).toEqual(["1", "2", "3"]);
    expect(parseChatIds({ TELEGRAM_ALLOWED_CHAT_ID: "-100123" })).toEqual(["-100123"]);
    expect(parseChatIds({ TELEGRAM_ALLOWED_CHAT_IDS: "5", TELEGRAM_ALLOWED_CHAT_ID: "9" })).toEqual(["5"]);
    expect(parseChatIds({})).toEqual([]);
  });
});

describe("parseUserIds", () => {
  it("is empty when unset and parses a list when set", () => {
    expect(parseUserIds({})).toEqual([]);
    expect(parseUserIds({ TELEGRAM_ALLOWED_USER_IDS: "10, 20,10" })).toEqual(["10", "20"]);
  });
});

describe("buildRuntime", () => {
  it("wires astronomia without Telegram (manual source last, buffer only with a key)", () => {
    const rt = buildRuntime(join(REPO_PROFILES, "astronomia"), cleanEnv(tmpDir()), { logger: silentLogger });
    try {
      expect(rt.sources.at(-1)?.type).toBe("manual");
      expect(rt.sources.length).toBe(12);
      expect(rt.publishers.buffer).toBeUndefined();
      expect(rt.bot).toBeUndefined();
      expect(rt.app.status().profileName).toBe("Céu de Hoje");
    } finally {
      rt.close();
    }
  });

  it("builds the bot and a buffer publisher when configured; refuses without token or chat", () => {
    const env = cleanEnv(tmpDir(), { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOWED_CHAT_IDS: "7", BUFFER_API_KEY: "b" });
    const rt = buildRuntime(join(REPO_PROFILES, "astronomia"), env, { withTelegram: true, logger: silentLogger });
    try {
      expect(rt.bot).toBeDefined();
      expect(rt.publishers.buffer?.name).toBe("buffer");
    } finally {
      rt.close();
    }
    expect(() => buildRuntime(join(REPO_PROFILES, "astronomia"), cleanEnv(tmpDir()), { withTelegram: true, logger: silentLogger })).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => buildRuntime(join(REPO_PROFILES, "astronomia"), cleanEnv(tmpDir(), { TELEGRAM_BOT_TOKEN: "t" }), { withTelegram: true, logger: silentLogger })).toThrow(/TELEGRAM_ALLOWED_CHAT_IDS/);
  });
});

describe("single-instance lock", () => {
  it("blocks a second live holder, releases, and takes over a stale lock", () => {
    const dir = tmpDir();
    const release = acquireLock(dir, process.pid);
    expect(() => acquireLock(dir, process.pid + 1)).toThrow(AlreadyRunningError);
    release();
    expect(existsSync(join(dir, ".start.lock"))).toBe(false);

    // stale: a pid that cannot be alive
    writeFileSync(join(dir, ".start.lock"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    const r2 = acquireLock(dir, process.pid);
    r2();
  });
});

describe("parseCommandLine", () => {
  it("parses flags and positionals; rejects unknown flags", () => {
    const a = parseCommandLine(["create", "x", "--template", "news-card", "--name", "N", "--offline"]);
    expect(a).toMatchObject({ command: "create", positionals: ["x"], template: "news-card", name: "N", offline: true });
    expect(parseCommandLine(["eval", "--case", "foo", "-p", "astronomia"])).toMatchObject({ case: "foo", profile: "astronomia" });
    expect(() => parseCommandLine(["doctor", "--oflline"])).toThrow(/inválido/);
  });
});
