import { KitError } from "@auto-curator/contracts";
import type { RunResult } from "./runner.js";

export type DownloaderErrorCode =
  | "NOT_AVAILABLE"
  | "INVALID_URL"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "TOO_LARGE"
  | "DOWNLOAD_FAILED";

/** Typed downloader failure. `code` is also the KitError code, so callers can match on either. */
export class DownloaderError extends KitError {
  declare readonly code: DownloaderErrorCode;
  constructor(message: string, code: DownloaderErrorCode = "DOWNLOAD_FAILED") {
    super(message, code);
    this.name = "DownloaderError";
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sessionid|csrftoken|ds_user_id|ig_did|mid|rur|shbid|shbts|msToken|sid_tt|sessionid_ss|auth_token|ct0)=[^\s;'"]+/gi,
  /\bcookie:\s*\S.*/gi,
];

/** Strips anything that looks like a cookie value or the cookies path, caps the length, drops control chars. */
export function redact(text: string, extraSecrets: readonly string[] = []): string {
  let out = text;
  for (const s of extraSecrets) if (s) out = out.split(s).join("[redacted]");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return out.length > 300 ? `${out.slice(0, 300)}...` : out;
}

function lastMeaningfulLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) => /^ERROR:/i.test(l));
  return err ?? lines[lines.length - 1] ?? "";
}

export interface ClassifyContext {
  hasCookies: boolean;
  cookiesPath?: string;
}

/** Maps a finished yt-dlp run (non-zero exit, or zero exit with a "skipped" notice) to a DownloaderError. */
export function classifyFailure(r: RunResult, ctx: ClassifyContext): DownloaderError {
  const detail = redact(lastMeaningfulLine(r.stderr), ctx.cookiesPath ? [ctx.cookiesPath] : []);
  const s = r.stderr;
  const make = (code: DownloaderErrorCode, msg: string) => new DownloaderError(detail ? `${msg}: ${detail}` : msg, code);

  if (r.spawnErrorCode === "ENOENT" || r.spawnErrorCode === "EACCES") {
    return new DownloaderError("yt-dlp nao encontrado ou sem permissao de execucao", "NOT_AVAILABLE");
  }
  if (r.timedOut) return new DownloaderError("yt-dlp excedeu o tempo limite", "DOWNLOAD_FAILED");
  if (r.spawnErrorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new DownloaderError("saida do yt-dlp excedeu o buffer", "TOO_LARGE");
  }
  if (/larger than max-filesize|does not pass filter|File is larger than/i.test(s)) {
    return make("TOO_LARGE", "Midia excede o limite de tamanho/duracao");
  }
  if (/rate-limit reached or login required/i.test(s)) {
    return ctx.hasCookies ? make("RATE_LIMITED", "Rate limit da plataforma (ou sessao expirada)") : make("AUTH_REQUIRED", "A plataforma exige login");
  }
  if (/HTTP Error 429|too many requests|rate.?limit|try again later|temporarily (blocked|unavailable)|spam/i.test(s)) {
    return make("RATE_LIMITED", "Rate limit da plataforma");
  }
  if (/log ?in|sign ?in|cookies|registered users|checkpoint|challenge_required|authentication|private (video|account|post)|HTTP Error 40[13]|follow this account/i.test(s)) {
    return make("AUTH_REQUIRED", "Autenticacao necessaria");
  }
  if (/HTTP Error 404|HTTP Error 410|not found|does not exist|no longer available|has been (removed|deleted)|video unavailable|content is not available|expired|Unsupported URL|No suitable extractor|no video could be found|There is no video/i.test(s)) {
    return make("NOT_FOUND", "Midia nao encontrada ou indisponivel");
  }
  return make("DOWNLOAD_FAILED", `yt-dlp falhou (exit ${r.exitCode ?? "n/a"})`);
}
