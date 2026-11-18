// Verifica a release publicada: baixa o asset, compara o SHA-256 e repete o smoke (SPEC-KIT 1.2b).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./api-report.mjs";

const REPO = "gpaiva00/auto-curator-kit";
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const tag = process.argv[2] ?? `v${pkg.version}`;
const expected = JSON.parse(readFileSync(join(ROOT, "release-artifacts", "release.json"), "utf8")).sha256;
const dir = mkdtempSync(join(tmpdir(), "ac-verify-"));
const fail = (msg) => {
  console.error(`[release:verify] ${msg}`);
  process.exitCode = 1;
};

try {
  const dl = spawnSync("gh", ["release", "download", tag, "--repo", REPO, "--pattern", "auto-curator-kit-*.tgz", "--dir", dir], { stdio: "inherit" });
  if (dl.status !== 0) throw new Error("gh release download falhou");
  const file = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  if (!file) throw new Error("asset .tgz não encontrado na release");
  const got = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
  if (got !== expected) throw new Error(`SHA-256 diferente: publicado ${got}, esperado ${expected}`);
  console.log(`[release:verify] SHA-256 bate (${file})`);
  const smoke = spawnSync(process.execPath, ["tools/smoke.mjs", "--tgz", join(dir, file)], { cwd: ROOT, stdio: "inherit" });
  if (smoke.status !== 0) throw new Error("smoke do asset publicado falhou");
  console.log(`[release:verify] ${tag} verificada`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
