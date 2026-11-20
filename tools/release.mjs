// Release local (SPEC-KIT 1.2b e 1.3). Não publica: sem push, sem gh release. Cria commit de registro e tag local.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_PATH, ROOT, buildApiReport } from "./api-report.mjs";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const OUT = join(ROOT, "release-artifacts");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const log = (msg) => console.log(`[release] ${msg}`);

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}
function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitOk(args) {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}
function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  must(r.status === 0, `${label} falhou`);
}
function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  must(m, `versão inválida: ${v}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
function sectionOf(text, version) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trimEnd();
}
function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function ensureIdentity() {
  if (gitOk(["config", "user.email"])) return [];
  return ["-c", "user.name=auto-curator release", "-c", "user.email=release@auto-curator.local"];
}

function main() {
  // 1. árvore limpa e tag ainda inexistente
  must(git(["status", "--porcelain"]) === "", "árvore suja; commite ou guarde antes do release");
  must(!gitOk(["rev-parse", "-q", "--verify", `refs/tags/${TAG}`]), `a tag ${TAG} já existe`);
  log(`árvore limpa, tag ${TAG} livre`);

  // 2. testes e typecheck
  run("bun", ["run", "test"], "testes");
  run("bun", ["run", "typecheck"], "typecheck");
  log("testes e typecheck verdes");

  // 3. build (escreve api/report.txt) e relatório de API sem diff
  run(process.execPath, ["tools/build.mjs"], "build");
  must(git(["status", "--porcelain"]) === "", `o build alterou arquivos versionados; revise e commite antes:\n${git(["status", "--porcelain"])}`);
  log("build ok, api/report.txt sem diff");

  // 4. regra de API: relatório mudou desde a última tag exige minor maior
  const lastTag = gitOk(["describe", "--tags", "--abbrev=0", "--match", "v*"]) ? git(["describe", "--tags", "--abbrev=0", "--match", "v*"]) : null;
  if (lastTag) {
    const previous = git(["show", `${lastTag}:api/report.txt`]);
    if (previous !== buildApiReport().trim()) {
      const cur = parseSemver(VERSION);
      const prev = parseSemver(lastTag);
      must(cur.major > prev.major || (cur.major === prev.major && cur.minor > prev.minor), `relatório de API mudou desde ${lastTag}; suba o minor`);
    }
    log(`regra de API ok frente a ${lastTag}`);
  } else {
    log("sem tag anterior: regra de API não se aplica");
  }

  // 5. CHANGELOG com a seção da versão, sem o rótulo de não lançado
  must(existsSync(CHANGELOG), "CHANGELOG.md ausente");
  const section = sectionOf(readFileSync(CHANGELOG, "utf8"), VERSION);
  must(section && section.split("\n").length > 3, `CHANGELOG.md sem a seção ## [${VERSION}] preenchida`);
  log(`CHANGELOG com a seção ${VERSION}`);

  // 6. pacote: o .tgz é o asset; o CHANGELOG não pode entrar nele (o hash fica lá)
  mkdirSync(OUT, { recursive: true });
  const tgzName = execFileSync("npm", ["pack", "--pack-destination", OUT], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop();
  const tgz = join(OUT, tgzName);
  const listed = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean);
  must(!listed.includes("package/CHANGELOG.md"), "o CHANGELOG entrou no .tgz; o hash não pode depender dele");
  log(`pacote ${tgzName} (${listed.length} arquivos)`);

  // 7. smoke de consumidor com o próprio .tgz (npm + Node 22.13.0 e atual)
  run(process.execPath, ["tools/smoke.mjs", "--tgz", tgz], "smoke de consumidor");

  // 8. SHA-256 no CHANGELOG e nas notas
  const hash = sha256(tgz);
  let text = readFileSync(CHANGELOG, "utf8").replace(/^Asset `auto-curator-kit-[^\n]*\n\n?/m, "");
  const heading = `## [${VERSION}]`;
  const at = text.indexOf(heading);
  must(at >= 0, "cabeçalho da versão sumiu");
  const headingEnd = text.indexOf("\n", at);
  text = `${text.slice(0, headingEnd + 1)}\nAsset \`${tgzName}\` · SHA-256 \`${hash}\`\n${text.slice(headingEnd + 1)}`;
  writeFileSync(CHANGELOG, text);
  const notes = join(OUT, `notas-${TAG}.md`);
  writeFileSync(notes, `${sectionOf(text, VERSION)}\n`);
  log(`SHA-256 ${hash} gravado no CHANGELOG e em ${notes}`);

  // 9. commit de registro e tag local
  git(["add", "CHANGELOG.md"]);
  // sem mudança no CHANGELOG (mesmo SHA de antes), não há o que commitar: a tag fica no HEAD que já traz o hash
  if (git(["diff", "--cached", "--name-only"]) !== "") {
    const msg = `chore(release): ${TAG}\n\nAsset ${tgzName}\nSHA-256 ${hash}\n\nCo-authored-by: OpenBot <335604065+openbotgit[bot]@users.noreply.github.com>`;
    execFileSync("git", [...ensureIdentity(), "commit", "-q", "-m", msg], { cwd: ROOT, stdio: "inherit" });
  }
  const commit = git(["rev-parse", "HEAD"]);
  execFileSync("git", [...ensureIdentity(), "tag", "-a", TAG, "-m", `auto-curator-kit ${TAG}`], { cwd: ROOT, stdio: "inherit" });
  writeFileSync(join(OUT, "release.json"), `${JSON.stringify({ version: VERSION, tag: TAG, commit, tgz: tgzName, sha256: hash, notes: notes }, null, 2)}\n`);
  must(git(["status", "--porcelain"]) === "", "árvore suja depois do release");
  log(`tag ${TAG} criada localmente em ${commit.slice(0, 7)}. Sem push e sem release publicada.`);
}

try {
  main();
} catch (e) {
  console.error(`[release] FALHOU: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
