import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT_PACKAGE_NAME = "auto-curator-kit";

/** Sobe a partir de startDir até o package.json com name "auto-curator-kit". Funciona no repo e dentro de node_modules. */
export function findKitRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    const file = join(dir, "package.json");
    if (existsSync(file) && (JSON.parse(readFileSync(file, "utf8")) as { name?: string }).name === KIT_PACKAGE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package.json de ${KIT_PACKAGE_NAME} não encontrado acima de ${startDir}`);
    dir = parent;
  }
}

let cachedRoot: string | undefined;
/** Raiz do kit (repo ou pacote instalado), calculada a partir deste arquivo. */
export function kitRoot(): string {
  cachedRoot ??= findKitRoot(dirname(fileURLToPath(import.meta.url)));
  return cachedRoot;
}

export function kitVersion(): string {
  return (JSON.parse(readFileSync(join(kitRoot(), "package.json"), "utf8")) as { version: string }).version;
}
