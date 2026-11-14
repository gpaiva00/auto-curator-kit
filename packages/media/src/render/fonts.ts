import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Fonts for satori. satori accepts ttf/otf/woff but NOT woff2.
 * @fontsource/inter ships .woff files (latin subset: covers all pt-BR diacritics).
 * To add another family, register it in FONT_FAMILIES below.
 */
export interface SatoriFont {
  name: string;
  data: Buffer;
  weight: 400 | 500 | 600 | 700 | 800;
  style: "normal";
}

const require = createRequire(import.meta.url);

function fontsourceFile(pkg: string, file: string): string {
  const pkgJson = require.resolve(`${pkg}/package.json`);
  return path.join(path.dirname(pkgJson), "files", file);
}

const FONT_FAMILIES: Record<string, { weight: SatoriFont["weight"]; file: () => string }[]> = {
  Inter: [
    { weight: 400, file: () => fontsourceFile("@fontsource/inter", "inter-latin-400-normal.woff") },
    { weight: 500, file: () => fontsourceFile("@fontsource/inter", "inter-latin-500-normal.woff") },
    { weight: 700, file: () => fontsourceFile("@fontsource/inter", "inter-latin-700-normal.woff") },
    { weight: 800, file: () => fontsourceFile("@fontsource/inter", "inter-latin-800-normal.woff") },
  ],
};

const cache = new Map<string, SatoriFont[]>();

/** Returns fonts for the family; unknown families fall back to Inter. */
export function loadFonts(family: string): { name: string; fonts: SatoriFont[] } {
  const key = family in FONT_FAMILIES ? family : "Inter";
  let fonts = cache.get(key);
  if (!fonts) {
    fonts = FONT_FAMILIES[key]!.map((f) => ({
      name: key,
      data: readFileSync(f.file()),
      weight: f.weight,
      style: "normal" as const,
    }));
    cache.set(key, fonts);
  }
  return { name: key, fonts };
}
