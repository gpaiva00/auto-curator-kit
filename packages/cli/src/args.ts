import { parseArgs } from "node:util";
import { KitError } from "@auto-curator/contracts";
import type { ParsedArgs } from "./io.js";

/** `<command> [positionals] [--profile x] [flags]`. Unknown flags are an error (typos should not pass silently). */
export function parseCommandLine(argv: string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        profile: { type: "string", short: "p" },
        template: { type: "string", short: "t" },
        name: { type: "string", short: "n" },
        case: { type: "string", short: "c" },
        offline: { type: "boolean", default: false },
        dry: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    throw new KitError(`Argumento inválido: ${(e as Error).message}`, "USAGE");
  }
  const [command = "", ...positionals] = parsed.positionals;
  const v = parsed.values;
  return {
    command,
    positionals,
    profile: v.profile,
    template: v.template,
    name: v.name,
    case: v.case,
    offline: v.offline ?? false,
    dry: v.dry ?? false,
    help: v.help ?? false,
  };
}
