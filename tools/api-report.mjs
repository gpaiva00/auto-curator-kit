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
