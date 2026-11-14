import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { KitError } from "@auto-curator/contracts";

export const LOCK_FILE = ".start.lock";
/** Exit code when another instance already runs (launchd retries after ThrottleInterval). */
export const EXIT_ALREADY_RUNNING = 75;

export class AlreadyRunningError extends KitError {
  constructor(readonly pid: number, file: string) {
    super(`Já existe uma instância rodando para este perfil (pid ${pid}, lock ${file}). Pare-a antes de iniciar outra: o bot do Telegram não pode ter dois pollings.`, "ALREADY_RUNNING");
    this.name = "AlreadyRunningError";
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readPid = (file: string): number | undefined => {
  try {
    const n = Number((JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
};

/** Single-instance lock: a file with our pid in the data dir. A lock whose pid is dead is taken over. Returns the release function. */
export function acquireLock(dataDir: string, pid: number = process.pid): () => void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
      closeSync(fd);
      return () => {
        if (readPid(file) === pid) {
          try {
            unlinkSync(file);
          } catch {
            /* already gone */
          }
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const other = readPid(file);
      if (other && other !== pid && alive(other)) throw new AlreadyRunningError(other, file);
      try {
        unlinkSync(file); // stale
      } catch {
        /* raced */
      }
    }
  }
  throw new KitError(`Não consegui obter o lock em ${file}.`, "LOCK");
}
