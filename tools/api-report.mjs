// Gera api/report.txt: os nomes exportados por cada entrada pública, lidos do compilador TypeScript.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPORT_PATH = join(ROOT, "api", "report.txt");

/** Entradas públicas (seção 2.1 do SPEC-KIT). Nome do subcaminho em exports, arquivo em entries/. */
export const ENTRIES = [
  { subpath: "", file: "index" },
  { subpath: "/contracts", file: "contracts" },
  { subpath: "/sources", file: "sources" },
  { subpath: "/publishers", file: "publishers" },
  { subpath: "/testing", file: "testing" },
];

export function loadCompilerOptions() {
  const cfg = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  return { ...parsed.options, noEmit: true };
}

/** Nomes com valor em runtime (não tipos) de uma entrada, para o bootstrap reexportar. */
export function valueExportNames(file) {
  const program = ts.createProgram({ rootNames: [join(ROOT, "entries", `${file}.ts`)], options: loadCompilerOptions() });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(join(ROOT, "entries", `${file}.ts`));
  const sym = checker.getSymbolAtLocation(sf);
  return checker
    .getExportsOfModule(sym)
    .filter((s) => ((s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s).flags & ts.SymbolFlags.Value) !== 0)
    .map((s) => s.getName())
    .sort();
}

export function buildApiReport() {
  const files = ENTRIES.map((e) => join(ROOT, "entries", `${e.file}.ts`));
  const program = ts.createProgram({ rootNames: files, options: loadCompilerOptions() });
  const checker = program.getTypeChecker();
  const sections = ENTRIES.map((e, i) => {
    const sf = program.getSourceFile(files[i]);
    if (!sf) throw new Error(`entrada não encontrada: ${files[i]}`);
    const sym = checker.getSymbolAtLocation(sf);
    if (!sym) throw new Error(`entrada sem exports: ${files[i]}`);
    const names = checker.getExportsOfModule(sym).map((s) => s.getName()).sort();
    return [`== auto-curator-kit${e.subpath}`, ...names].join("\n");
  });
  return sections.join("\n") + "\n";
}
