import { pathToFileURL } from "node:url";
import { errMsg } from "@auto-curator/contracts";
import { parseCommandLine } from "./args.js";
import { createCommand } from "./commands/create.js";
import { doctorCommand } from "./commands/doctor.js";
import { dryRunCommand } from "./commands/dryrun.js";
import { evalCommand } from "./commands/eval.js";
import { scanCommand } from "./commands/scan.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { consoleIo, type CmdCtx } from "./io.js";

export const HELP = `auto-curator: motor para perfis curados por IA com aprovação no Telegram

Uso: tsx packages/cli/src/main.ts <comando> [--profile <id ou pasta>] [opções]
     (ou: bun run <comando> -- --profile <id>)

Comandos
  create <id>   cria profiles/<id>/ (--template news-card|thought-leader, --name "Nome")
  doctor        confere configuração, chaves, bot, fontes, Buffer e ferramentas (--offline pula a rede)
  scan          lê as fontes uma vez, sem IA, e grava no banco (--dry só mostra)
  dry-run       roda o pipeline inteiro com dados falsos, sem rede (teste de fumaça)
  eval          roda os casos do Curador no modelo real (--case <nome> filtra)
  start         liga o bot do Telegram e o agendador (fica rodando)
  status        mostra contagens, gasto e limites do perfil

O perfil vem de --profile (um id em profiles/ ou um caminho) ou da variável CURADOR_PROFILE.
`;

export type Handler = (ctx: CmdCtx) => Promise<number>;
export const COMMANDS: Record<string, Handler> = {
  create: createCommand,
  doctor: (c) => doctorCommand(c),
  scan: scanCommand,
  "dry-run": dryRunCommand,
  eval: evalCommand,
  start: (c) => startCommand(c),
  status: statusCommand,
};

/** Runs one command line and returns the exit code (never calls process.exit). */
export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env, io = consoleIo, profilesRoot?: string): Promise<number> {
  try {
    const args = parseCommandLine(argv);
    if (!args.command || args.command === "help" || (args.help && !COMMANDS[args.command])) {
      io.out(HELP);
      return args.command || args.help ? 0 : 1;
    }
    const handler = COMMANDS[args.command];
    if (!handler) {
      io.err(`Comando desconhecido: "${args.command}".\n`);
      io.err(HELP);
      return 1;
    }
    if (args.help) {
      io.out(HELP);
      return 0;
    }
    return await handler({ env, io, args, profilesRoot });
  } catch (e) {
    io.err(`❌ ${errMsg(e)}`);
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const code = await run(process.argv.slice(2));
  // open handles (undici sockets, sqlite) must not keep a finished command alive
  process.exit(code);
}
