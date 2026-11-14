import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DownloaderError } from "./errors.js";
import { readCapped, resolvesPublic, systemLookup, type Lookup } from "./net.js";
import { validateMediaUrl } from "./url.js";

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};

export interface DownloadFileOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** Accepted content-type prefixes. Default ["image/"]. */
  accept?: string[];
  /** Allow plain http (tests / legacy CDNs). Default false. */
  allowHttp?: boolean;
  /** DNS resolver used to refuse hosts that resolve to private addresses. Default: system DNS when `fetch` is the real one. null disables. */
  lookup?: Lookup | null;
}

const MAX_REDIRECTS = 5;

/**
 * Downloads one file over fetch into outDir (name = hash of the URL, so repeats are idempotent).
 * Checks content-type (default: images only), size and timeout. Throws DownloaderError.
 */
export async function downloadFile(url: string, outDir: string, opts: DownloadFileOptions = {}): Promise<{ localPath: string; contentType: string; bytes: number }> {
  const u = validateMediaUrl(url, { allowHttp: opts.allowHttp });
  const f = opts.fetch ?? fetch;
  const accept = opts.accept ?? ["image/"];
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  const lookup = opts.lookup === undefined ? (f === globalThis.fetch ? systemLookup : undefined) : (opts.lookup ?? undefined);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  // Redirects are followed by hand: every hop must pass the same checks as the first URL (public host, public DNS answers).
  let res!: Response;
  let cur = u;
  for (let hop = 0; ; hop++) {
    if (lookup && !(await resolvesPublic(new URL(cur).hostname, lookup))) throw new DownloaderError(`host nao publico: ${new URL(cur).host}`, "INVALID_URL");
    try {
      res = await f(cur, { signal, redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (compatible; auto-curator-kit)" } });
    } catch (e) {
      throw new DownloaderError(`falha ao baixar ${new URL(cur).host}: ${e instanceof Error ? e.message : String(e)}`, "DOWNLOAD_FAILED");
    }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) break;
    await res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new DownloaderError("redirecionamentos demais", "DOWNLOAD_FAILED");
    let next: string;
    try {
      next = new URL(loc, cur).toString();
    } catch {
      throw new DownloaderError("redirecionamento invalido", "DOWNLOAD_FAILED");
    }
    cur = validateMediaUrl(next, { allowHttp: opts.allowHttp });
  }
  if (res.status === 404 || res.status === 410) throw new DownloaderError(`arquivo nao encontrado (HTTP ${res.status})`, "NOT_FOUND");
  if (res.status === 401 || res.status === 403) throw new DownloaderError(`acesso negado (HTTP ${res.status})`, "AUTH_REQUIRED");
  if (res.status === 429) throw new DownloaderError("rate limit (HTTP 429)", "RATE_LIMITED");
  if (!res.ok) throw new DownloaderError(`HTTP ${res.status}`, "DOWNLOAD_FAILED");
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!accept.some((a) => contentType.startsWith(a))) throw new DownloaderError(`tipo de conteudo inesperado: ${contentType || "(vazio)"}`, "DOWNLOAD_FAILED");
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new DownloaderError("arquivo grande demais", "TOO_LARGE");
  const buf = await readCapped(res, maxBytes);
  if (!buf) throw new DownloaderError("arquivo grande demais", "TOO_LARGE");
  if (buf.length === 0) throw new DownloaderError("arquivo vazio", "DOWNLOAD_FAILED");
  const ext = EXT_BY_TYPE[contentType] ?? contentType.split("/")[1]?.replace(/[^a-z0-9]/g, "") ?? "bin";
  await mkdir(outDir, { recursive: true });
  const localPath = path.join(path.resolve(outDir), `dl-${createHash("sha1").update(u).digest("hex").slice(0, 12)}.${ext}`);
  await writeFile(localPath, buf);
  return { localPath, contentType, bytes: buf.length };
}
