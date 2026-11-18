// Publica a tag local e cria a release no GitHub (SPEC-KIT 1.2b). Só com confirmação interativa.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ROOT } from "./api-report.mjs";

const REPO = "gpaiva00/auto-curator-kit";
const OUT = join(ROOT, "release-artifacts");
const rel = JSON.parse(readFileSync(join(OUT, "release.json"), "utf8"));
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fail = (msg) => {
  console.error(`[release:publish] ${msg}`);
  process.exit(1);
};

if (git(["status", "--porcelain"]) !== "") fail("árvore suja; a publicação exige árvore limpa");
if (git(["rev-parse", `${rel.tag}^{commit}`]) !== rel.commit) fail(`a tag ${rel.tag} não aponta para o commit do release (${rel.commit.slice(0, 7)})`);
const tgz = join(OUT, rel.tgz);
if (!existsSync(tgz)) fail(`${rel.tgz} não existe; rode "bun run release"`);
const hash = createHash("sha256").update(readFileSync(tgz)).digest("hex");
if (hash !== rel.sha256) fail("o SHA-256 do .tgz não bate com o registrado; rode \"bun run release\" de novo");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`Publicar ${rel.tag} (${rel.tgz}) em ${REPO}? Digite PUBLICAR para confirmar: `);
rl.close();
if (answer.trim() !== "PUBLICAR") fail("publicação cancelada");

const push = spawnSync("git", ["push", "origin", rel.tag], { cwd: ROOT, stdio: "inherit" });
if (push.status !== 0) fail("git push da tag falhou");
const gh = spawnSync("gh", ["release", "create", rel.tag, tgz, "--repo", REPO, "--title", `auto-curator-kit ${rel.tag}`, "--notes-file", rel.notes], { cwd: ROOT, stdio: "inherit" });
if (gh.status !== 0) fail("gh release create falhou (confira a permissão do token)");
console.log(`[release:publish] ${rel.tag} publicada. Confira com: bun run release:verify`);
