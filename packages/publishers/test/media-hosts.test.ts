import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMediaHostFromEnv, ImgbbHost, R2Host } from "../src/media-hosts.js";
import { fakeFetch, json } from "./fake-fetch.js";

const file = (name: string, content: string) => {
  const dir = mkdtempSync(join(tmpdir(), "pub-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};
const r2 = (f: typeof fetch) =>
  new R2Host({ accountId: "acc", accessKeyId: "AKID", secretAccessKey: "secret", bucket: "media", publicUrl: "https://m.test/", fetch: f, now: () => new Date("2026-11-09T02:49:00Z") });

describe("R2Host", () => {
  it("PUTs a SigV4-signed, content-addressed object and returns its public URL", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const host = r2(fetch);
    const p = file("reel.mp4", "video-bytes");
    const url = await host.upload(p);
    expect(await host.upload(p)).toBe(url);
    expect(url).toMatch(/^https:\/\/m\.test\/[0-9a-f]{24}\.mp4$/);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`https://acc.r2.cloudflarestorage.com/media/${url.split("/").pop()}`);
    const h = calls[0]!.headers;
    expect(h["content-type"]).toBe("video/mp4");
    expect(h["x-amz-date"]).toBe("20261109T024900Z");
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/20261109\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(h.authorization).not.toContain("secret");
  });

  it("supports images and video, and surfaces HTTP errors", async () => {
    const host = r2(fakeFetch(() => new Response("no", { status: 403 })).fetch);
    expect(host.supports("image")).toBe(true);
    expect(host.supports("video")).toBe(true);
    await expect(host.upload(file("a.jpg", "x"))).rejects.toThrow("HTTP 403");
  });

  it("remove tolerates a missing object", async () => {
    const host = r2(fakeFetch(() => new Response(null, { status: 404 })).fetch);
    await expect(host.remove("https://m.test/abc.mp4")).resolves.toBeUndefined();
  });
});

describe("ImgbbHost", () => {
  it("uploads the image as base64 and returns its URL; images only", async () => {
    const { fetch, calls } = fakeFetch(() => json({ success: true, data: { url: "https://i.ibb.co/x/a.jpg" } }));
    const host = new ImgbbHost({ apiKey: "KEY", fetch });
    expect(await host.upload(file("a.jpg", "img"))).toBe("https://i.ibb.co/x/a.jpg");
    expect(calls[0]!.url).toBe("https://api.imgbb.com/1/upload?key=KEY");
    expect(host.supports("image")).toBe(true);
    expect(host.supports("video")).toBe(false);
  });

  it("errors on HTTP failure and on a response without url", async () => {
    await expect(new ImgbbHost({ apiKey: "K", fetch: fakeFetch(() => json({}, 400)).fetch }).upload(file("a.jpg", "x"))).rejects.toThrow("HTTP 400");
    await expect(new ImgbbHost({ apiKey: "K", fetch: fakeFetch(() => json({ data: {} })).fetch }).upload(file("a.jpg", "x"))).rejects.toThrow("URL");
  });
});

describe("createMediaHostFromEnv", () => {
  const r2Env = { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "AKID", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET: "media", R2_PUBLIC_URL: "https://m.test" };

  it("prefers R2 when fully configured, then imgbb, else undefined", () => {
    expect(createMediaHostFromEnv({ ...r2Env, IMGBB_API_KEY: "k" })!.name).toBe("r2");
    expect(createMediaHostFromEnv({ IMGBB_API_KEY: "k" })!.name).toBe("imgbb");
    expect(createMediaHostFromEnv({})).toBeUndefined();
  });

  it("does not pick R2 with a partial configuration", () => {
    const { R2_PUBLIC_URL: _omit, ...partial } = r2Env;
    expect(createMediaHostFromEnv({ ...partial, IMGBB_API_KEY: "k" })!.name).toBe("imgbb");
    expect(createMediaHostFromEnv(partial)).toBeUndefined();
  });
});
