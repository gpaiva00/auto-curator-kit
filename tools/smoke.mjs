// Smoke de consumidor (SPEC-KIT 1.2a): npm pack -> npm install do .tgz -> import das entradas -> tsc com skipLibCheck false -> doctor.
// Roda com node e npm, num diretório temporário. Uso: node tools/smoke.mjs [--keep]
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./api-report.mjs";

const KEEP = process.argv.includes("--keep");
const log = (msg) => console.log(`[smoke] ${msg}`);

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} falhou (${r.status})\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  return r.stdout;
}

const PROBE = `import assert from "node:assert/strict";
const kit = await import("auto-curator-kit");
const contracts = await import("auto-curator-kit/contracts");
const sources = await import("auto-curator-kit/sources");
const publishers = await import("auto-curator-kit/publishers");
const testing = await import("auto-curator-kit/testing");
assert.equal(typeof kit.run, "function");
assert.equal(typeof kit.buildRuntime, "function");
assert.equal(typeof kit.loadProfile, "function");
assert.equal(typeof kit.kitVersion, "function");
assert.ok(contracts.KitError);
assert.equal(typeof sources.registerSource, "function");
assert.equal(typeof publishers.BufferPublisher, "function");
assert.equal(typeof testing.FakeLlm, "function");
for (const spec of ["auto-curator-kit/dist/index.js", "auto-curator-kit/packages/engine/src/index.ts", "auto-curator-kit/dist/entries/index.d.ts"]) {
  await assert.rejects(import(spec), (e) => e.code === "ERR_PACKAGE_PATH_NOT_EXPORTED", spec);
}
console.log(JSON.stringify({ version: kit.kitVersion(), exportsRun: typeof kit.run, internalPathsBlocked: 3 }));
`;

const CHECK_TS = `import { run, buildRuntime, loadProfile, KitError, ConfigError, kitVersion, type Runtime, type ProfileBundle } from "auto-curator-kit";
import type { Item, Draft, Publisher, Source, ProfileConfig, PublishRequest, PublishResult, MediaHost, Preparer, Logger, Clock } from "auto-curator-kit/contracts";
import { createRssSource, registerSource, type SourceDeps } from "auto-curator-kit/sources";
import { BufferPublisher, R2Host, ImgbbHost, type R2Options } from "auto-curator-kit/publishers";
import { FakeLlm, makeBundle, okDraft, fixedClock } from "auto-curator-kit/testing";

export const values: unknown[] = [run, buildRuntime, loadProfile, KitError, ConfigError, kitVersion, createRssSource, registerSource, BufferPublisher, R2Host, ImgbbHost, FakeLlm, makeBundle, okDraft, fixedClock];
export type Types = [Runtime, ProfileBundle, Item, Draft, Publisher, Source, ProfileConfig, PublishRequest, PublishResult, MediaHost, Preparer, Logger, Clock, SourceDeps, R2Options];
`;

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", skipLibCheck: false },
  files: ["check.ts"],
});

const DOCTOR = `import { run } from "auto-curator-kit";
const lines = [];
const io = { out: (l = "") => lines.push(l), err: (l = "") => lines.push(l) };
const code = await run(["doctor", "--profile", "astronomia"], {}, io);
const failed = lines.filter((l) => l.includes("❌"));
// Só falhas de variável de ambiente são esperadas: o smoke roda com env vazio e sem .env.
const envOnly = /(API_KEY|TELEGRAM_|BUFFER_API|IMGBB|R2_|Hospedagem de mídia|problema\\(s\\))/;
const unexpected = failed.filter((l) => !envOnly.test(l));
const templateOk = lines.some((l) => l.includes('Template "news-card" encontrado'));
console.log(JSON.stringify({ exitCode: code, templateOk, envFailures: failed.length - unexpected.length, unexpected }));
process.exitCode = templateOk && unexpected.length === 0 ? 0 : 1;
`;

function checkPackContents() {
  const out = sh("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  const need = ["dist/index.js", "dist/entries/index.d.ts", "templates/news-card/template.json", "scripts/chrome-reader.sh", "profiles/astronomia/profile.json"];
  for (const n of need) if (!files.includes(n)) throw new Error(`pacote sem ${n}`);
  const forbidden = files.filter((f) => /^(packages|entries|tools|api)\//.test(f) || /(^|\/)\.env$|\.env\.(?!example$)/.test(f));
  if (forbidden.length) throw new Error(`pacote contém arquivos que não devem ir: ${forbidden.join(", ")}`);
  log(`pacote: ${files.length} arquivos, sem fonte interna nem .env`);
}

function main() {
  log("build");
  sh(process.execPath, ["tools/build.mjs"], { cwd: ROOT, stdio: "inherit" });
  checkPackContents();

  const work = mkdtempSync(join(tmpdir(), "ac-smoke-"));
  const packDir = join(work, "pack");
  const consumer = join(work, "consumer");
  mkdirSync(packDir);
  mkdirSync(consumer);
  try {
    const tgzName = sh("npm", ["pack", "--pack-destination", packDir], { cwd: ROOT }).trim().split("\n").pop();
    const tgz = join(packDir, tgzName);
    log(`tarball: ${tgzName}`);

    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "smoke-consumer", version: "0.0.0", private: true, type: "module" }, null, 2));
    sh("npm", ["install", "--no-audit", "--no-fund", tgz, "typescript@5"], { cwd: consumer });
    log("npm install do tarball: ok");

    writeFileSync(join(consumer, "probe.mjs"), PROBE);
    const probe = sh(process.execPath, ["probe.mjs"], { cwd: consumer }).trim();
    log(`import das entradas + caminho interno bloqueado: ${probe}`);

    writeFileSync(join(consumer, "check.ts"), CHECK_TS);
    writeFileSync(join(consumer, "tsconfig.json"), TSCONFIG);
    sh(process.execPath, [join(consumer, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], { cwd: consumer });
    log("tsc com skipLibCheck false: ok");

    writeFileSync(join(consumer, "doctor.mjs"), DOCTOR);
    const doctor = spawnSync(process.execPath, ["doctor.mjs"], { cwd: consumer, encoding: "utf8" });
    if (doctor.status !== 0) throw new Error(`doctor falhou:\n${doctor.stdout}${doctor.stderr}`);
    log(`doctor (env vazio): ${doctor.stdout.trim()}`);
    log("smoke ok");
  } finally {
    if (KEEP) log(`mantido em ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (e) {
  console.error(`[smoke] FALHOU: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
