import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** All calls use execFile with an argv array (no shell). Paths come from the caller, never from user text. */
export async function run(bin: "ffmpeg" | "ffprobe", args: string[], timeoutMs = 300_000): Promise<string> {
  try {
    const { stdout } = await execFileP(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`${bin} failed: ${(err.stderr ?? err.message).toString().split("\n").slice(-6).join("\n")}`);
  }
}

export interface ProbeInfo {
  hasVideo: boolean;
  hasAudio: boolean;
  durationSec: number;
  width?: number;
  height?: number;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const out = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "--", file]);
  const j = JSON.parse(out) as {
    streams?: { codec_type: string; width?: number; height?: number; duration?: string; disposition?: { attached_pic?: number }; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[];
    format?: { duration?: string; format_name?: string };
  };
  const streams = j.streams ?? [];
  // attached pictures (cover art in mp3) are not real video
  // still images (jpg/png/webp...) show up as one-frame "video" streams: not usable as real video
  const isImage = /image2|_pipe/.test(j.format?.format_name ?? "");
  const v = isImage ? undefined : streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const dur = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  return {
    hasVideo: !!v,
    hasAudio: !!a,
    durationSec: Number.isFinite(dur) ? dur : 0,
    // ffmpeg auto-rotates phone videos, so the effective size swaps when the stream is rotated by 90/270
    ...(() => {
      const rot = Math.abs(Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0)) % 180;
      return rot === 90 ? { width: v?.height, height: v?.width } : { width: v?.width, height: v?.height };
    })(),
  };
}

export interface CropRect {
  w: number;
  h: number;
  x: number;
  y: number;
}

/**
 * Finds black bars (letterbox / pillarbox) in the first seconds with ffmpeg's cropdetect and returns the content
 * rectangle. Returns null when there are no bars, or when the detected area is implausibly small (then we keep the
 * whole frame rather than crop away most of the video).
 */
export async function detectBlackBars(file: string, seconds = 10): Promise<CropRect | null> {
  const info = await probe(file);
  if (!info.width || !info.height) return null;
  const { width: W, height: H } = info;
  let stderr = "";
  try {
    ({ stderr } = await execFileP("ffmpeg", [
      "-hide_banner", "-v", "info", "-t", String(seconds), "-i", file,
      "-vf", "cropdetect=limit=24:round=2:reset=0", "-an", "-f", "null", "-",
    ], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    stderr = (e as { stderr?: string }).stderr ?? "";
  }
  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const last = matches.at(-1);
  if (!last) return null;
  const [w, h, x, y] = last.slice(1).map(Number) as [number, number, number, number];
  if (w >= W * 0.98 && h >= H * 0.98) return null; // no meaningful bars
  if (w < W * 0.4 || h < H * 0.4) return null; // implausible: keep the whole frame
  return { w, h, x, y };
}

let ffmpegCache: Promise<boolean> | undefined;
/** True when both ffmpeg and ffprobe run. Cached for the process. */
export function ffmpegAvailable(): Promise<boolean> {
  ffmpegCache ??= (async () => {
    try {
      await run("ffmpeg", ["-version"], 10_000);
      await run("ffprobe", ["-version"], 10_000);
      return true;
    } catch {
      return false;
    }
  })();
  return ffmpegCache;
}

/** Extracts one frame (png) from a video, used when an image card is fed a video. */
export async function extractFrame(videoFile: string, outFile: string, atSec = 1): Promise<void> {
  const info = await probe(videoFile);
  const t = Math.max(0, Math.min(atSec, info.durationSec > 1 ? info.durationSec / 2 : 0));
  await run("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", videoFile, "-frames:v", "1", outFile]);
}
