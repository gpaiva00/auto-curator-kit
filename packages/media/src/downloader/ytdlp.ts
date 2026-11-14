import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { MediaDownloader } from "@auto-curator/contracts";
import { classifyFailure, DownloaderError } from "./errors.js";
import { RateLimiter } from "./limiter.js";
import { childEnv, defaultRunner, type Runner, type RunResult } from "./runner.js";
import { validateMediaUrl } from "./url.js";

export interface YtDlpOptions {
  /** Path or name of the yt-dlp binary. Use an absolute path under launchd/cron. */
  bin: string;
  ffprobeBin: string;
  /** Netscape cookies file (optional, never logged). */
  cookiesFile?: string;
  /** Kill switch: isAvailable() is false and download() throws NOT_AVAILABLE. */
  disabled: boolean;
  maxFileSizeMb: number;
  /** Default max duration when download() gets no `maxDurationSec`. */
  maxDurationSec: number;
  /** Max files per URL (carousels). */
  maxItems: number;
  timeoutMs: number;
  minDelayMs: number;
  jitterMs: number;
  maxPerHour: number;
  cooldownMs: number;
  /** Test seams. */
  runner: Runner;
  limiter?: RateLimiter;
  now: () => number;
}

export interface UrlProbe {
  title?: string;
  uploader?: string;
  durationSec?: number;
  itemCount: number;
  /** ISO date when the platform reports it. */
  postedAt?: string;
}

export type DownloadedFile = { type: "image" | "video"; localPath: string; durationSec?: number };

const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 30_000;
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);
// Prefer H.264/AAC mp4 so Telegram and the publishers rarely need a transcode.
const FORMAT_SELECTOR = "bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/b[vcodec^=avc1][ext=mp4]/bv*+ba/b";

const posNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const str = (v: unknown, max = 300): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** yt-dlp wrapper (MediaDownloader). All process spawning goes through `runner` (execFile, no shell). */
export class YtDlpDownloader implements MediaDownloader {
  private readonly o: YtDlpOptions;
  private readonly limiter: RateLimiter;
  private availCache: { ok: boolean; at: number } | null = null;

  constructor(opts: Partial<YtDlpOptions> = {}) {
    this.o = {
      bin: "yt-dlp",
      ffprobeBin: "ffprobe",
      disabled: false,
      maxFileSizeMb: 80,
      maxDurationSec: 300,
      maxItems: 1,
      timeoutMs: 180_000,
      minDelayMs: 2_000,
      jitterMs: 1_000,
      maxPerHour: 60,
      cooldownMs: 10 * 60_000,
      runner: defaultRunner,
      now: Date.now,
      ...opts,
    };
    this.limiter =
      this.o.limiter ?? new RateLimiter({ minDelayMs: this.o.minDelayMs, jitterMs: this.o.jitterMs, maxPerHour: this.o.maxPerHour, cooldownMs: this.o.cooldownMs });
  }

  /** `yt-dlp --version` exits 0. Cached 5 min (30 s on failure). Never throws. */
  async isAvailable(): Promise<boolean> {
    if (this.o.disabled) return false;
    const t = this.o.now();
    if (this.availCache && t - this.availCache.at < (this.availCache.ok ? OK_TTL_MS : FAIL_TTL_MS)) return this.availCache.ok;
    let ok = false;
    try {
      const r = await this.o.runner(this.o.bin, ["--version"], { timeoutMs: 10_000, maxBuffer: 64 * 1024, env: childEnv() });
      ok = r.exitCode === 0 && r.stdout.trim().length > 0;
    } catch {
      ok = false;
    }
    this.availCache = { ok, at: t };
    return ok;
  }

  /** JSON probe (`--dump-single-json --no-download`): title, uploader, duration, number of items. */
  async probe(url: string): Promise<UrlProbe> {
    const u = validateMediaUrl(url);
    await this.assertReady();
    const args = [...this.baseArgs(), "--dump-single-json", "--no-download", "--playlist-items", `1:${this.o.maxItems}`, "--", u];
    const r = await this.limiter.schedule(() => this.o.runner(this.o.bin, args, { timeoutMs: 60_000, maxBuffer: 20 * 1024 * 1024, env: childEnv() }));
    this.throwIfFailed(r);
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(r.stdout) as Record<string, unknown>;
    } catch {
      throw new DownloaderError("yt-dlp devolveu metadados ilegiveis", "DOWNLOAD_FAILED");
    }
    const entries = Array.isArray(j.entries) ? (j.entries as Record<string, unknown>[]) : null;
    const first = entries?.[0] ?? j;
    return {
      title: str(j.title ?? first.title),
      uploader: str(first.uploader ?? first.channel ?? j.uploader, 100),
      durationSec: posNum(first.duration),
      itemCount: entries ? entries.length : 1,
      postedAt: postedAtOf(first) ?? postedAtOf(j),
    };
  }

  async download(url: string, outDir: string, opts: { maxDurationSec?: number } = {}): Promise<DownloadedFile[]> {
    const u = validateMediaUrl(url);
    await this.assertReady();
    const dir = path.resolve(outDir);
    await mkdir(dir, { recursive: true });
    const maxDur = opts.maxDurationSec ?? this.o.maxDurationSec;
    const prefix = `media_${randomBytes(5).toString("hex")}_`;
    const args = [
      ...this.baseArgs(),
      "--max-downloads", String(this.o.maxItems),
      "--max-filesize", `${this.o.maxFileSizeMb}M`,
      "--match-filters", `duration<=?${maxDur}`,
      "--no-write-info-json", "--no-write-thumbnail", "--no-write-description", "--no-write-subs", "--no-mtime", "--no-overwrites",
      // a carousel can mix photos and videos: a photo slide fails with "No video formats found", keep the others
      "--ignore-errors",
      "-f", FORMAT_SELECTOR,
      "--merge-output-format", "mp4",
      "-o", `${prefix}%(autonumber)02d.%(ext)s`,
      "--", u,
    ];
    const r = await this.limiter.schedule(() => this.o.runner(this.o.bin, args, { cwd: dir, timeoutMs: this.o.timeoutMs, maxBuffer: 4 * 1024 * 1024, env: childEnv() }));
    const names = (await readdir(dir)).filter((n) => n.startsWith(prefix) && !n.endsWith(".part") && !n.endsWith(".ytdl")).sort();
    // exit 101 = --max-downloads reached (normal); exit 1 with --ignore-errors = some slide failed, keep the rest
    const partialOk = names.length > 0 && r.exitCode === 1 && !r.timedOut && !r.spawnErrorCode && !/HTTP Error 429|rate.?limit|login required/i.test(r.stderr);
    if (r.exitCode !== 101 && !partialOk) this.throwIfFailed(r);
    if (names.length === 0) throw classifyFailure({ ...r, exitCode: r.exitCode ?? 1 }, this.ctx());

    const out: DownloadedFile[] = [];
    for (const n of names) {
      const file = path.join(dir, n);
      if (!(await stat(file)).isFile()) continue;
      const ext = path.extname(n).slice(1).toLowerCase();
      if (IMAGE_EXT.has(ext)) out.push({ type: "image", localPath: file });
      else out.push({ type: "video", localPath: file, durationSec: await this.durationOf(file) });
    }
    if (out.length === 0) throw new DownloaderError("yt-dlp nao produziu arquivos", "DOWNLOAD_FAILED");
    return out;
  }

  // ---- internals ----

  private ctx() {
    return { hasCookies: !!this.o.cookiesFile, cookiesPath: this.o.cookiesFile };
  }

  private async assertReady(): Promise<void> {
    if (this.o.disabled) throw new DownloaderError("Downloader desativado", "NOT_AVAILABLE");
    if (!(await this.isAvailable())) throw new DownloaderError("yt-dlp nao encontrado", "NOT_AVAILABLE");
  }

  /** Flags common to every call. Nothing here comes from item data. */
  private baseArgs(): string[] {
    const a = [
      "--ignore-config", "--no-cache-dir", "--no-progress", "--color", "never", "--no-update", "--no-playlist",
      "--socket-timeout", "20", "--retries", "2", "--extractor-retries", "1", "--fragment-retries", "2",
    ];
    if (this.o.cookiesFile) a.push("--cookies", this.o.cookiesFile);
    return a;
  }

  private throwIfFailed(r: RunResult): void {
    const filtered = /larger than max-filesize|does not pass filter/i.test(r.stderr);
    if (r.exitCode === 0 && !r.timedOut && !r.spawnErrorCode && !filtered) return;
    const err = classifyFailure(r, this.ctx());
    if (err.code === "RATE_LIMITED") this.limiter.trip();
    throw err;
  }

  /** Duration through ffprobe; undefined when ffprobe is missing. */
  private async durationOf(file: string): Promise<number | undefined> {
    const r = await this.o.runner(this.o.ffprobeBin, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", "--", file], {
      timeoutMs: 15_000, maxBuffer: 64 * 1024, env: childEnv(),
    });
    if (r.exitCode !== 0) return undefined;
    return posNum(Number(r.stdout.trim()));
  }
}

/** yt-dlp gives `timestamp` (epoch seconds) or `upload_date` (YYYYMMDD). */
function postedAtOf(j: Record<string, unknown>): string | undefined {
  if (typeof j.timestamp === "number" && j.timestamp > 0) return new Date(j.timestamp * 1000).toISOString();
  const m = typeof j.upload_date === "string" ? /^(\d{4})(\d{2})(\d{2})$/.exec(j.upload_date) : null;
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 15)).toISOString() : undefined;
}
