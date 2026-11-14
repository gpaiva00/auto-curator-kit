import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { REPO_ROOT } from "@auto-curator/engine";

const dirs: string[] = [];
export function tmpDir(prefix = "cli-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export const REPO_PROFILES = join(REPO_ROOT, "profiles");
/** A clean env: no API keys, data dir in a temp folder. */
export const cleanEnv = (data: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, CURADOR_DATA_DIR: data, ...extra });
