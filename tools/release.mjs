// Verificações de release (SPEC-KIT 1.3 e 1.2a). Não faz commit, não cria tag e não faz push: isso é da K6 e depende do dono.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_PATH, ROOT, buildApiReport } from "./api-report.mjs";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
const log = (msg) => console.log(`[release] ${msg}`);

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${label} falhou`);
}

function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`versão inválida: ${v}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function main() {
  const dirty = git(["status", "--porcelain"]);
  if (dirty) throw new Error(`árvore suja; commite ou guarde antes do release:\n${dirty}`);
  log("árvore limpa");

  run("bun", ["run", "test"], "testes");
  run("bun", ["run", "typecheck"], "typecheck");
  log("testes e typecheck verdes");

  run(process.execPath, ["tools/build.mjs"], "build");
  const afterBuild = git(["status", "--porcelain"]);
  if (afterBuild) throw new Error(`o build alterou arquivos versionados; revise e commite antes:\n${afterBuild}`);

  // Regra 1.3: relatório de API mudou em relação à última tag exige minor maior.
  let lastTag = null;
  try {
    lastTag = git(["describe", "--tags", "--abbrev=0", "--match", "v*"]);
  } catch {
    lastTag = null;
  }
  if (lastTag) {
    const previous = git(["show", `${lastTag}:api/report.txt`]);
    if (previous !== buildApiReport().trim()) {
      const cur = parseSemver(version);
      const prev = parseSemver(lastTag);
      if (!(cur.major > prev.major || (cur.major === prev.major && cur.minor > prev.minor))) {
        throw new Error(`relatório de API mudou desde ${lastTag}; suba o minor de ${lastTag.replace(/^v/, "")} (hoje ${version})`);
      }
    }
    log(`regra de API ok frente a ${lastTag}`);
  } else {
    log("sem tag anterior: regra de API não se aplica");
  }

  const changelog = join(ROOT, "CHANGELOG.md");
  if (!existsSync(changelog) || !readFileSync(changelog, "utf8").includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG.md sem a seção ## [${version}]`);
  }
  log(`CHANGELOG com a seção ${version}`);

  run(process.execPath, ["tools/smoke.mjs"], "smoke de consumidor");
  log(`verificações ok para ${version} (relatório: ${REPORT_PATH}). Sem commit, sem tag, sem push.`);
}

try {
  main();
} catch (e) {
  console.error(`[release] FALHOU: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
