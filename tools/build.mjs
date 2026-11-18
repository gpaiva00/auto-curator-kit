// Gera dist/: um .js por entrada pública (pacotes internos embutidos), .d.ts sem @auto-curator/*, e api/report.txt.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { ENTRIES, REPORT_PATH, ROOT, buildApiReport, loadCompilerOptions, valueExportNames } from "./api-report.mjs";

const DIST = join(ROOT, "dist");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const externals = Object.keys(pkg.dependencies ?? {});

function fail(msg) {
  throw new Error(`build: ${msg}`);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function bundleJs() {
  const args = [
    ...ENTRIES.map((e) => `entries/${e.file}.ts`),
    "entries/bin.ts",
    "--root", "entries", "--outdir", "dist/impl",
    "--target", "node", "--format", "esm", "--splitting",
    ...externals.flatMap((e) => ["--external", e]),
  ];
  const r = spawnSync("bun", ["build", ...args], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) fail("bun build falhou");
  // Nenhuma importação de terceiro pode escapar sem estar em dependencies (o consumidor não teria o pacote).
  for (const file of walk(DIST).filter((f) => f.endsWith(".js"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
      if (!externals.includes(spec)) fail(`${relative(ROOT, file)} importa "${spec}", que não está em dependencies`);
    }
  }
}

/** Bootstrap por entrada: checa o runtime antes de carregar o impl (que abre node:sqlite no load). */
function writeBootstraps() {
  const head = `import { assertRuntime } from "./runtime.js";\nassertRuntime();\n`;
  for (const e of ENTRIES) {
    const names = valueExportNames(e.file);
    const body = names.length ? `const m = await import("./impl/${e.file}.js");\nexport const { ${names.join(", ")} } = m;\n` : `await import("./impl/${e.file}.js");\n`;
    writeFileSync(join(DIST, `${e.file}.js`), head + body);
  }
  writeFileSync(join(DIST, "bin.js"), head + `await import("./impl/bin.js");\n`);
}

function bundleRuntime() {
  const r = spawnSync("bun", ["build", "entries/runtime-check.ts", "--outfile", "dist/runtime.js", "--target", "node", "--format", "esm"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) fail("bun build do runtime-check falhou");
}

function emitDeclarations() {
  const options = { ...loadCompilerOptions(), noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: DIST, rootDir: ROOT };
  const rootNames = ENTRIES.map((e) => join(ROOT, "entries", `${e.file}.ts`));
  const program = ts.createProgram({ rootNames, options });
  const diags = ts.getPreEmitDiagnostics(program);
  if (diags.length) fail(ts.formatDiagnostics(diags, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => ROOT, getNewLine: () => "\n" }));
  const res = program.emit();
  if (res.emitSkipped) fail("emissão de .d.ts foi pulada");
}

/** "@auto-curator/<pkg>[/<sub>]" -> caminho do .d.ts emitido para o arquivo-fonte que o exports do pacote aponta. */
function declarationFor(spec) {
  const [, name, ...rest] = spec.split("/");
  const pkgDir = join(ROOT, "packages", name);
  const pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const key = rest.length ? `./${rest.join("/")}` : ".";
  const target = typeof pj.exports?.[key] === "string" ? pj.exports[key] : undefined;
  if (!target) fail(`${spec} não está em exports de packages/${name}`);
  const src = join(pkgDir, target);
  const dts = join(DIST, relative(ROOT, src).replace(/\.ts$/, ".d.ts"));
  if (!existsSync(dts)) fail(`declaração de ${spec} não foi emitida (${relative(ROOT, dts)})`);
  return dts;
}

function rewriteDeclarations() {
  for (const file of walk(DIST).filter((f) => f.endsWith(".d.ts"))) {
    const src = readFileSync(file, "utf8");
    const out = src.replace(/(["'])(@auto-curator\/[^"']+)\1/g, (_m, q, spec) => {
      let rel = relative(dirname(file), declarationFor(spec)).replace(/\.d\.ts$/, ".js");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${q}${rel}${q}`;
    });
    if (out !== src) writeFileSync(file, out);
  }
  const left = walk(DIST).filter((f) => /\.(d\.ts|js)$/.test(f) && readFileSync(f, "utf8").includes("@auto-curator/"));
  if (left.length) fail(`ainda citam @auto-curator/*: ${left.map((f) => relative(ROOT, f)).join(", ")}`);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
bundleJs();
bundleRuntime();
writeBootstraps();
emitDeclarations();
rewriteDeclarations();
mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, buildApiReport());
console.log(`build ok: ${walk(DIST).length} arquivos em dist/, api/report.txt atualizado`);
