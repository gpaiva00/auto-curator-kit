// Smoke de consumidor (SPEC-KIT 1.2a e 1.2a-bis): npm pack -> npm install do .tgz -> import, bin, tsc, doctor, trava de escrita.
// Roda com npm e Node (piso 22.13.0 e a versão atual), num diretório temporário. Uso: node tools/smoke.mjs [--keep]
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ROOT } from "./api-report.mjs";

const KEEP = process.argv.includes("--keep");
// --tgz <arquivo>: instala exatamente este .tgz (o mesmo que vira asset da release), sem build nem pack novo.
const TGZ_AT = process.argv.indexOf("--tgz");
const PREPACKED = TGZ_AT > 0 ? resolve(process.argv[TGZ_AT + 1]) : undefined;
const FLOOR = "22.13.0";
const OLD = "22.12.0";
const log = (msg) => console.log(`[smoke] ${msg}`);

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} falhou (${r.status})\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  return r.stdout;
}

/** Roda um script com um Node específico: "current" é o da máquina; outra versão vem via npx node@<v>. */
function node(version, args, opts) {
  const r =
    version === "current"
      ? spawnSync(process.execPath, args, { encoding: "utf8", ...opts })
      : spawnSync("npx", ["-y", `node@${version}`, ...args], { encoding: "utf8", timeout: 300000, ...opts });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
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
for (const spec of ["auto-curator-kit/dist/index.js", "auto-curator-kit/packages/engine/src/index.ts", "auto-curator-kit/dist/impl/index.js"]) {
  await assert.rejects(import(spec), (e) => e.code === "ERR_PACKAGE_PATH_NOT_EXPORTED", spec);
}
console.log(JSON.stringify({ version: kit.kitVersion(), run: typeof kit.run, internalPathsBlocked: 3 }));
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

// argv: <argumento do --profile ou "-"> <pasta de dados ou "-"> <"plugin" ou "-">. Imprime todas as linhas e o código.
// "plugin" liga um plugin de fonte definido no consumidor (tipo minha-fonte), como um projeto faria.
const DOCTOR = `import { run } from "auto-curator-kit";
const [profileArg, dataArg, pluginArg] = process.argv.slice(2);
const env = dataArg && dataArg !== "-" ? { CURADOR_DATA_DIR: dataArg } : {};
const lines = [];
const io = { out: (l = "") => lines.push(l), err: (l = "") => lines.push(l) };
const argv = profileArg === "-" ? ["doctor"] : ["doctor", "--profile", profileArg];
const plugins = pluginArg === "plugin" ? { sources: { "minha-fonte": (cfg) => ({ type: "minha-fonte", name: cfg.name ?? "minha-fonte", fetch: async () => [] }) } } : undefined;
const code = await run(argv, { env, io, plugins });
console.log(JSON.stringify({ code, lines }));
`;

// Só falhas de variável de ambiente são esperadas: o smoke roda com env vazio e sem .env.
const ENV_ONLY = /(API_KEY|TELEGRAM_|BUFFER_API|IMGBB|R2_|Hospedagem de mídia|problema\(s\))/;

function doctorRun(version, dir, profileArg, dataArg = "-", pluginArg = "-") {
  const r = node(version, ["doctor.mjs", profileArg, dataArg, pluginArg], { cwd: dir });
  const json = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  must(json, `doctor não produziu saída (${version}): ${r.out}`);
  return JSON.parse(json);
}

function checkDoctorOk(res) {
  const failed = res.lines.filter((l) => l.includes("❌"));
  const unexpected = failed.filter((l) => !ENV_ONLY.test(l));
  must(res.lines.some((l) => l.includes('Template "news-card" encontrado')), "doctor não achou o template instalado");
  must(unexpected.length === 0, `doctor com falha inesperada: ${unexpected.join(" | ")}`);
  return failed.length;
}

function checkPackContents() {
  const files = PREPACKED
    ? sh("tar", ["-tzf", PREPACKED]).split("\n").filter(Boolean).map((p) => p.replace(/^package\//, ""))
    : JSON.parse(sh("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT }))[0].files.map((f) => f.path);
  const need = ["dist/index.js", "dist/bin.js", "dist/runtime.js", "dist/impl/index.js", "dist/entries/index.d.ts", "templates/news-card/template.json", "scripts/chrome-reader.sh", "profiles/astronomia/profile.json"];
  for (const n of need) must(files.includes(n), `pacote sem ${n}`);
  const forbidden = files.filter((f) => /^(packages|entries|tools|api)\//.test(f) || /(^|\/)\.env$|\.env\.(?!example$)/.test(f));
  must(forbidden.length === 0, `pacote contém arquivos que não devem ir: ${forbidden.join(", ")}`);
  log(`pacote: ${files.length} arquivos, sem fonte interna nem .env`);
}

function typesCount(dir) {
  return sh("find", ["node_modules", "-path", "*/@types/node/package.json"], { cwd: dir }).trim().split("\n").filter(Boolean).length;
}

function consumerVariant(work, tgz, variant) {
  const consumer = join(work, `consumer-${variant}`);
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "smoke-consumer", version: "0.0.0", private: true, type: "module" }, null, 2));
  const extra = variant === "types22" ? ["@types/node@22"] : [];
  sh("npm", ["install", "--no-audit", "--no-fund", tgz, "typescript@5", ...extra], { cwd: consumer });
  const count = typesCount(consumer);
  must(count === 1, `@types/node duplicado no consumidor (${variant}): ${count} cópias`);
  log(`consumidor "${variant}": npm install ok, @types/node em ${count} cópia (${variant === "types22" ? "a do consumidor" : "instalada como peer automática"})`);
  return consumer;
}

function main() {
  if (!PREPACKED) {
    log("build");
    sh(process.execPath, ["tools/build.mjs"], { cwd: ROOT, stdio: "inherit" });
  }
  checkPackContents();

  const work = mkdtempSync(join(tmpdir(), "ac-smoke-"));
  const packDir = join(work, "pack");
  mkdirSync(packDir);
  try {
    const tgz = PREPACKED ?? join(packDir, sh("npm", ["pack", "--pack-destination", packDir], { cwd: ROOT }).trim().split("\n").pop());
    const tgzName = basename(tgz);
    log(`tarball: ${tgzName}`);

    for (const variant of ["auto", "types22"]) {
      const consumer = consumerVariant(work, tgz, variant);
      writeFileSync(join(consumer, "probe.mjs"), PROBE);
      writeFileSync(join(consumer, "doctor.mjs"), DOCTOR);
      writeFileSync(join(consumer, "check.ts"), CHECK_TS);
      writeFileSync(join(consumer, "tsconfig.json"), TSCONFIG);

      // Node atual: import, tsc com skipLibCheck false, doctor e as travas.
      const probe = node("current", ["probe.mjs"], { cwd: consumer });
      must(probe.status === 0, `probe falhou (${variant}): ${probe.out}`);
      log(`import das entradas + caminhos internos bloqueados (${variant}): ${probe.out.trim().split("\n").pop()}`);

      const tsc = spawnSync(process.execPath, [join(consumer, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], { cwd: consumer, encoding: "utf8" });
      must(tsc.status === 0, `tsc com skipLibCheck false falhou (${variant}):\n${tsc.stdout}${tsc.stderr}`);
      log(`tsc com skipLibCheck false (${variant}): ok`);

      // Perfil copiado para fora do pacote; a cópia não tem .env.
      const profile = join(consumer, "perfil-astronomia");
      cpSync(join(ROOT, "profiles", "astronomia"), profile, { recursive: true, filter: (src) => !/(^|\/)\.env$/.test(src) });
      const ok = doctorRun("current", consumer, profile);
      const envFailures = checkDoctorOk(ok);
      must(existsSync(join(profile, "data")), "dados não foram para <perfil>/data");
      must(!existsSync(join(consumer, "node_modules", "auto-curator-kit", "data")), "dados foram gravados dentro de node_modules");
      log(`doctor com perfil copiado (${variant}): code ${ok.code}, ${envFailures} falhas só de env, dados em <perfil>/data`);

      // Plugin de fonte definido no consumidor (seção 3): sem ele o tipo é acusado; com ele, o doctor reconhece a fonte.
      const pluginProfile = join(consumer, "perfil-plugin");
      cpSync(profile, pluginProfile, { recursive: true });
      const pjPath = join(pluginProfile, "profile.json");
      const pj = JSON.parse(readFileSync(pjPath, "utf8"));
      pj.sources = [{ type: "minha-fonte", name: "projeto" }];
      writeFileSync(pjPath, JSON.stringify(pj));
      const semPlugin = doctorRun("current", consumer, pluginProfile);
      must(semPlugin.lines.some((l) => /minha-fonte.*desconhecido/.test(l)), "tipo de plugin não foi acusado sem o plugin");
      const comPlugin = doctorRun("current", consumer, pluginProfile, "-", "plugin");
      must(comPlugin.lines.some((l) => l.includes("✅ Fonte minha-fonte")), "plugin de fonte do consumidor não foi reconhecido");
      log(`plugin de fonte no consumidor (${variant}): acusado sem plugin, reconhecido com plugin`);

      // Travas: perfil obrigatório, id sem PROFILES_DIR, dados dentro do pacote.
      const noProfile = doctorRun("current", consumer, "-");
      must(noProfile.lines.some((l) => /Perfil não informado.*CURADOR_PROFILE/.test(l)), "perfil obrigatório não recusou sem --profile");
      const byId = doctorRun("current", consumer, "astronomia");
      must(byId.lines.some((l) => l.includes("PROFILES_DIR")), "busca por id não exigiu PROFILES_DIR");
      const inside = doctorRun("current", consumer, profile, join(consumer, "node_modules", "auto-curator-kit", "data"));
      must(inside.code === 1 && inside.lines.some((l) => /dentro de node_modules.*CURADOR_DATA_DIR/.test(l)), "trava não recusou dados dentro do próprio kit em node_modules");

      // Perfil e dados em node_modules de OUTRO pacote, e os mesmos caminhos via symlink: tudo recusado, sem criar banco.
      const lib = join(consumer, "node_modules", "perfil-na-lib");
      mkdirSync(lib, { recursive: true });
      writeFileSync(join(lib, "package.json"), JSON.stringify({ name: "perfil-na-lib", version: "1.0.0" }));
      const libProfile = join(lib, "astronomia");
      cpSync(join(ROOT, "profiles", "astronomia"), libProfile, { recursive: true, filter: (src) => !/(^|\/)\.env$/.test(src) });
      const libData = join(lib, "dados");
      const refusedProfile = (r) => r.code === 1 && r.lines.some((l) => /O perfil está dentro de node_modules/.test(l));
      const refusedData = (r) => r.code === 1 && r.lines.some((l) => /Os dados ficariam dentro de node_modules/.test(l));

      must(refusedProfile(doctorRun("current", consumer, libProfile)), "perfil em node_modules de outro pacote não foi recusado");
      must(!existsSync(join(libProfile, "data")), "banco criado dentro do perfil em node_modules");
      must(refusedData(doctorRun("current", consumer, profile, libData)), "dados em node_modules de outro pacote não foram recusados");
      must(!existsSync(libData), "pasta de dados criada dentro de node_modules");

      symlinkSync(libProfile, join(consumer, "link-perfil"));
      must(refusedProfile(doctorRun("current", consumer, join(consumer, "link-perfil"))), "perfil via symlink para node_modules não foi recusado");
      symlinkSync(lib, join(consumer, "link-lib"));
      must(refusedData(doctorRun("current", consumer, profile, join(consumer, "link-lib", "dados"))), "dados via symlink para node_modules não foram recusados");
      must(!existsSync(libData), "dados criados via symlink dentro de node_modules");
      log(`travas (${variant}): perfil obrigatório, id sem PROFILES_DIR, dados e perfil em node_modules (kit e outro pacote), inclusive via symlink`);

      // Binário da CLI.
      const bin = node("current", [join("node_modules", "auto-curator-kit", "dist", "bin.js"), "--help"], { cwd: consumer });
      must(bin.status === 0 && bin.out.includes("auto-curator <comando>"), `binário não respondeu --help: ${bin.out}`);
      log(`binário auto-curator --help (${variant}): ok`);

      if (variant === "auto") {
        // Piso: Node 22.13.0 carrega e roda; 22.12.0 recebe a mensagem em português, sem ERR_UNKNOWN_BUILTIN_MODULE.
        const floor = node(FLOOR, ["probe.mjs"], { cwd: consumer });
        must(floor.status === 0, `probe falhou no Node ${FLOOR}: ${floor.out}`);
        const floorDoctor = doctorRun(FLOOR, consumer, profile);
        checkDoctorOk(floorDoctor);
        log(`Node ${FLOOR} (piso): import e doctor ok`);

        const old = node(OLD, ["probe.mjs"], { cwd: consumer });
        must(old.status === 1 && /Node 22\.12\.0 não é suportado/.test(old.out) && !/ERR_UNKNOWN_BUILTIN_MODULE/.test(old.out), `Node ${OLD} não recusou com a mensagem`);
        const oldBin = node(OLD, [join("node_modules", "auto-curator-kit", "dist", "bin.js"), "--help"], { cwd: consumer });
        must(oldBin.status === 1 && /não é suportado/.test(oldBin.out), `binário no Node ${OLD} não recusou`);
        log(`Node ${OLD}: recusado com mensagem em português (pacote e binário)`);

        const bun = spawnSync("bun", ["probe.mjs"], { cwd: consumer, encoding: "utf8" });
        must(bun.status === 1 && /roda sob Node/.test(`${bun.stdout}${bun.stderr}`), "Bun não recusou com a mensagem em português");
        const bunBin = spawnSync("bun", [join("node_modules", "auto-curator-kit", "dist", "bin.js"), "--help"], { cwd: consumer, encoding: "utf8" });
        must(bunBin.status === 1 && /Bun/.test(`${bunBin.stdout}${bunBin.stderr}`), "binário sob Bun não recusou");
        log("Bun: recusado com mensagem em português (pacote e binário)");
      }
    }
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
