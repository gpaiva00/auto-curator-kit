import path from "node:path";
import { BrandConfig, type ProfileConfig } from "@auto-curator/contracts";

/** Brand as the renderer sees it: colors and font filled in, logo resolved to an absolute path (or undefined). */
export interface ResolvedBrand {
  name: string;
  handle: string;
  /** Absolute path of the logo file (may not exist: the renderer falls back to a monogram). */
  logoPath?: string;
  colors: { primary: string; accent: string; background: string; text: string };
  fontFamily: string;
}

/** profile.brand (logo relative to profileDir), or profile.name with default colors when the profile has no brand. */
export function resolveBrand(profile: Pick<ProfileConfig, "name" | "brand">, profileDir: string): ResolvedBrand {
  const b = BrandConfig.parse(profile.brand ?? { name: profile.name });
  return {
    name: b.name || profile.name,
    handle: b.handle,
    ...(b.logo ? { logoPath: path.resolve(profileDir, b.logo) } : {}),
    colors: b.colors,
    fontFamily: b.fontFamily,
  };
}
