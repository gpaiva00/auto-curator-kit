/** Where commands print. Tests inject a buffer; the real CLI uses the console. */
export interface Io {
  out(line?: string): void;
  err(line?: string): void;
}

export const consoleIo: Io = {
  out: (l = "") => console.log(l),
  err: (l = "") => console.error(l),
};

/** Collects output in memory (tests). */
export function bufferIo(): Io & { lines: string[]; text(): string } {
  const lines: string[] = [];
  return {
    lines,
    out: (l = "") => void lines.push(l),
    err: (l = "") => void lines.push(l),
    text: () => lines.join("\n"),
  };
}

export interface CmdCtx {
  env: NodeJS.ProcessEnv;
  io: Io;
  /** Parsed command line. */
  args: ParsedArgs;
  /** Root that holds profiles/<id> (injectable for tests). Default: <repo>/profiles. */
  profilesRoot?: string;
}

export interface ParsedArgs {
  command: string;
  positionals: string[];
  profile?: string;
  template?: string;
  name?: string;
  case?: string;
  port?: string;
  offline: boolean;
  dry: boolean;
  help: boolean;
}
