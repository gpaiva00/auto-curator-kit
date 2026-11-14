import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KitError } from "@auto-curator/contracts";
import { DownloaderError, RateLimiter, YtDlpDownloader, downloadFile, validateMediaUrl, type Runner, type RunResult } from "../src/index.js";

let dir: string;
beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "media-dl-")); });
afterAll(() => rm(dir, { recursive: true, force: true }));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const respond = (body: Buffer | string, type: string, status = 200): typeof fetch =>
  (async () => new Response(body as BodyInit, { status, headers: { "content-type": type } })) as typeof fetch;

describe("downloadFile", () => {
  it("saves an image and names it by URL hash (idempotent)", async () => {
    const a = await downloadFile("https://cdn.example.com/a.jpg", dir, { fetch: respond(PNG, "image/png") });
    const b = await downloadFile("https://cdn.example.com/a.jpg", dir, { fetch: respond(PNG, "image/png") });
    expect(a.localPath).toBe(b.localPath);
    expect(a.localPath.endsWith(".png")).toBe(true);
    expect((await readFile(a.localPath)).equals(PNG)).toBe(true);
  });
  it("rejects non-image content types, errors, empty files and size overflow", async () => {
    await expect(downloadFile("https://x.example.com/a", dir, { fetch: respond("<html>", "text/html") })).rejects.toThrow(/tipo de conteudo/);
    await expect(downloadFile("https://x.example.com/a", dir, { fetch: respond("", "image/png", 404) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(downloadFile("https://x.example.com/a", dir, { fetch: respond(Buffer.alloc(0), "image/png") })).rejects.toBeInstanceOf(DownloaderError);
    await expect(downloadFile("https://x.example.com/a", dir, { fetch: respond(PNG, "image/png"), maxBytes: 10 })).rejects.toMatchObject({ code: "TOO_LARGE" });
  });
  it("maps network failures to DOWNLOAD_FAILED", async () => {
    const boom = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    const e = await downloadFile("https://x.example.com/a", dir, { fetch: boom }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KitError);
    expect((e as DownloaderError).code).toBe("DOWNLOAD_FAILED");
  });
  it("follows redirects by hand, refuses private hops and private DNS answers, and caps the stream", async () => {
    const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
    const seen: (string | undefined)[] = [];
    const routes: Record<string, () => Response> = {
      "https://a.example.com/img": () => redirect("https://cdn.example.com/a.png"),
      "https://cdn.example.com/a.png": () => new Response(PNG as BodyInit, { headers: { "content-type": "image/png" } }),
      "https://b.example.com/img": () => redirect("https://127.0.0.1/secret"),
      "https://c.example.com/img": () => redirect("http://cdn.example.com/a.png"),
    };
    const f = (async (u: string, init?: RequestInit) => (seen.push(init?.redirect), routes[u]?.() ?? new Response("", { status: 404 }))) as unknown as typeof fetch;
    const pub = async () => ["93.184.216.34"];
    const ok = await downloadFile("https://a.example.com/img", dir, { fetch: f, lookup: pub });
    expect(ok.bytes).toBe(PNG.length);
    expect(seen.every((r) => r === "manual")).toBe(true);
    await expect(downloadFile("https://b.example.com/img", dir, { fetch: f, lookup: pub })).rejects.toMatchObject({ code: "INVALID_URL" });
    await expect(downloadFile("https://c.example.com/img", dir, { fetch: f, lookup: pub })).rejects.toMatchObject({ code: "INVALID_URL" });
    await expect(downloadFile("https://a.example.com/img", dir, { fetch: f, lookup: async () => ["10.1.2.3"] })).rejects.toMatchObject({ code: "INVALID_URL" });
    const big = (async () => new Response(new Uint8Array(5000), { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    await expect(downloadFile("https://x.example.com/big", dir, { fetch: big, maxBytes: 100 })).rejects.toMatchObject({ code: "TOO_LARGE" });
  });
  it("validates URLs: https only, no credentials, no private hosts", () => {
    for (const bad of ["http://a.com/x", "file:///etc/passwd", "https://u:p@a.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://192.168.0.5/x", "javascript:1", ""]) {
      expect(() => validateMediaUrl(bad), bad).toThrow(DownloaderError);
    }
    expect(validateMediaUrl("https://pbs.twimg.com/media/a.jpg?name=large")).toContain("twimg.com");
  });
});

function fakeRunner(handler: (file: string, args: readonly string[]) => Partial<RunResult> | Promise<Partial<RunResult>>): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const r = (async (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...(await handler(file, args)) };
  }) as unknown as Runner & { calls: string[][] };
  r.calls = calls;
  return r;
}
const fast = { minDelayMs: 0, jitterMs: 0 };

describe("YtDlpDownloader", () => {
  it("isAvailable uses --version and honors disabled", async () => {
    const ok = new YtDlpDownloader({ ...fast, runner: fakeRunner(() => ({ stdout: "2026.10.01\n" })) });
    expect(await ok.isAvailable()).toBe(true);
    const missing = new YtDlpDownloader({ ...fast, runner: fakeRunner(() => ({ exitCode: null, spawnErrorCode: "ENOENT" })) });
    expect(await missing.isAvailable()).toBe(false);
    const off = new YtDlpDownloader({ ...fast, disabled: true, runner: fakeRunner(() => ({ stdout: "1" })) });
    expect(await off.isAvailable()).toBe(false);
    await expect(off.download("https://x.com/a/status/1", dir)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });

  it("download passes max duration and returns typed files", async () => {
    const runner = fakeRunner(async (file, args) => {
      if (args[0] === "--version") return { stdout: "2026.10.01" };
      if (file === "yt-dlp") {
        const o = args[args.indexOf("-o") + 1]!;
        await writeFile(path.join(dir, o.replace("%(autonumber)02d.%(ext)s", "01.mp4")), "x");
        return {};
      }
      return { stdout: "12.5\n" }; // ffprobe duration
    });
    const d = new YtDlpDownloader({ ...fast, runner });
    const files = await d.download("https://x.com/a/status/1", dir, { maxDurationSec: 90 });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ type: "video", durationSec: 12.5 });
    const call = runner.calls.find((c) => c.includes("--match-filters"))!;
    expect(call[call.indexOf("--match-filters") + 1]).toBe("duration<=?90");
    expect(call).toContain("--no-playlist");
  });

  it("classifies failures into typed KitError codes", async () => {
    const run = (stderr: string, exitCode = 1) => new YtDlpDownloader({ ...fast, runner: fakeRunner((_f, a) => (a[0] === "--version" ? { stdout: "2026.10.01" } : { stderr, exitCode })) });
    await expect(run("ERROR: HTTP Error 404: Not Found").download("https://x.com/a/status/1", dir)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(run("ERROR: private video, log in").download("https://x.com/a/status/1", dir)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(run("ERROR: HTTP Error 429: Too Many Requests").download("https://x.com/a/status/1", dir)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(run("does not pass filter duration<=?10", 0).download("https://x.com/a/status/1", dir)).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(run("ERROR: boom").download("https://x.com/a/status/1", dir)).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    await expect(run("").download("http://insecure.example/x", dir)).rejects.toMatchObject({ code: "INVALID_URL" });
  });

  it("a rate limit trips the cooldown", async () => {
    const d = new YtDlpDownloader({ ...fast, runner: fakeRunner((_f, a) => (a[0] === "--version" ? { stdout: "1" } : { stderr: "HTTP Error 429", exitCode: 1 })) });
    await expect(d.download("https://x.com/a/status/1", dir)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(d.download("https://x.com/a/status/2", dir)).rejects.toThrow(/pausa/);
  });

  it("probe parses the JSON dump", async () => {
    const json = JSON.stringify({ title: "T", uploader: "U", duration: 42, upload_date: "20260101" });
    const d = new YtDlpDownloader({ ...fast, runner: fakeRunner((_f, a) => (a[0] === "--version" ? { stdout: "1" } : { stdout: json })) });
    expect(await d.probe("https://x.com/a/status/1")).toMatchObject({ title: "T", uploader: "U", durationSec: 42, itemCount: 1 });
  });

  it("RateLimiter enforces the hourly cap", async () => {
    const l = new RateLimiter({ minDelayMs: 0, jitterMs: 0, maxPerHour: 1, cooldownMs: 1000 });
    await l.schedule(async () => 1);
    await expect(l.schedule(async () => 2)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
