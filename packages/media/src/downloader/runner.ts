import { execFile } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** null if the process was killed or never started. */
  exitCode: number | null;
  timedOut: boolean;
  /** Set when the binary could not be spawned (e.g. ENOENT, EACCES). */
  spawnErrorCode?: string;
}

export type Runner = (file: string, args: readonly string[], opts: RunOptions) => Promise<RunResult>;

/** The only place that spawns processes. execFile with shell:false: arguments are never interpreted by a shell. */
export const defaultRunner: Runner = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        shell: false,
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: opts.maxBuffer,
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, exitCode: 0, timedOut: false });
        const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string | null };
        const timedOut = e.killed === true && e.signal != null;
        if (typeof e.code === "number") {
          return resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode: e.code, timedOut });
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: null,
          timedOut,
          spawnErrorCode: typeof e.code === "string" ? e.code : "UNKNOWN",
        });
      },
    );
  });

/** Minimal environment for children: no API keys or other secrets leak into yt-dlp/ffmpeg. */
export function childEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}
