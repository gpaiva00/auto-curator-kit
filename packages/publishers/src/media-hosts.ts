import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { MediaHost } from "@auto-curator/contracts";

/** imgBB image hosting (free, permanent URLs). Images only. https://api.imgbb.com */
export class ImgbbHost implements MediaHost {
  readonly name = "imgbb";
  constructor(private readonly o: { apiKey: string; fetch?: typeof fetch }) {}

  supports(kind: "image" | "video"): boolean {
    return kind === "image";
  }

  async upload(localPath: string): Promise<string> {
    const form = new FormData();
    form.set("image", readFileSync(localPath).toString("base64"));
    const res = await (this.o.fetch ?? fetch)(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(this.o.apiKey)}`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`imgBB: upload falhou (HTTP ${res.status})`);
    const json = (await res.json()) as { data?: { url?: string }; success?: boolean };
    if (!json.data?.url) throw new Error("imgBB: a resposta não trouxe a URL da imagem");
    return json.data.url;
  }
}

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

const sha256 = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (key: string | Buffer, d: string) => createHmac("sha256", key).update(d).digest();

export interface R2Options {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Public base URL of the bucket (custom domain or the r2.dev URL). A trailing slash is fine. */
  publicUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Cloudflare R2 media host (S3-compatible API, SigV4 signed with node:crypto, no SDK).
 * Serves images and video through the bucket's public URL. Object keys are content-addressed, so re-uploading
 * the same file is idempotent and returns the same URL.
 */
export class R2Host implements MediaHost {
  readonly name = "r2";
  constructor(private readonly o: R2Options) {}

  supports(_kind: "image" | "video"): boolean {
    return true;
  }

  async upload(localPath: string): Promise<string> {
    const body = readFileSync(localPath);
    const ext = extname(localPath).toLowerCase();
    const key = `${sha256(body).slice(0, 24)}${ext}`;
    const res = await this.request("PUT", key, body, TYPES[ext] ?? "application/octet-stream");
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`R2: envio falhou (HTTP ${res.status}) ${detail}`.trim());
    }
    return `${this.o.publicUrl.replace(/\/+$/, "")}/${key}`;
  }

  /** Removes an object previously returned by upload() (by its public URL). Missing objects are fine. */
  async remove(url: string): Promise<void> {
    const key = url.slice(url.lastIndexOf("/") + 1);
    const res = await this.request("DELETE", key, Buffer.alloc(0));
    if (!res.ok && res.status !== 404) throw new Error(`R2: remoção falhou (HTTP ${res.status})`);
  }

  private request(method: "PUT" | "DELETE", key: string, body: Buffer, contentType?: string) {
    const host = `${this.o.accountId}.r2.cloudflarestorage.com`;
    const path = `/${this.o.bucket}/${encodeURIComponent(key)}`;
    const now = (this.o.now ?? (() => new Date()))();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20261109T024900Z
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256(body);
    const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    if (contentType) headers["content-type"] = contentType;
    const names = Object.keys(headers).sort();
    const canonical = [method, path, "", names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
    const scope = `${day}/auto/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.o.secretAccessKey}`, day), "auto"), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.o.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
    const { host: _h, ...sendHeaders } = headers;
    return (this.o.fetch ?? fetch)(`https://${host}${path}`, {
      method,
      headers: { ...sendHeaders, authorization },
      body: method === "PUT" ? new Uint8Array(body) : undefined,
    });
  }
}

/**
 * R2 when every R2_* variable is set (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL),
 * else imgBB when IMGBB_API_KEY is set, else undefined.
 */
export function createMediaHostFromEnv(env: NodeJS.ProcessEnv, f?: typeof fetch): MediaHost | undefined {
  const v = (k: string) => env[k]?.trim() || undefined;
  const accountId = v("R2_ACCOUNT_ID");
  const accessKeyId = v("R2_ACCESS_KEY_ID");
  const secretAccessKey = v("R2_SECRET_ACCESS_KEY");
  const bucket = v("R2_BUCKET");
  const publicUrl = v("R2_PUBLIC_URL");
  if (accountId && accessKeyId && secretAccessKey && bucket && publicUrl) {
    return new R2Host({ accountId, accessKeyId, secretAccessKey, bucket, publicUrl, fetch: f });
  }
  const imgbb = v("IMGBB_API_KEY");
  if (imgbb) return new ImgbbHost({ apiKey: imgbb, fetch: f });
  return undefined;
}
