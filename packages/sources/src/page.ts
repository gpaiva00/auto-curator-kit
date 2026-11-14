import { metaTags } from "./html.js";
import { safeGet } from "./safe-fetch.js";
import { BROWSER_UA, isPublicUrl } from "./util.js";

export const MAX_HTML_BYTES = 1_500_000;

/** Downloads an HTML page from a public host (size-capped). Returns undefined (never throws) on any failure. */
export async function readHtml(url: string, f: typeof fetch, opts: { timeoutMs: number; allowHttp?: boolean }): Promise<{ html: string; finalUrl: string } | undefined> {
  try {
    const got = await safeGet(url, f, {
      headers: { "user-agent": BROWSER_UA, "accept-language": "pt-BR,pt;q=0.9", accept: "text/html,application/xhtml+xml" },
      timeoutMs: opts.timeoutMs,
      maxBytes: MAX_HTML_BYTES,
      allowHttp: opts.allowHttp,
    });
    if (!got) return undefined;
    const { res, finalUrl, body: buf } = got;
    const ctype = res.headers.get("content-type") ?? "text/html";
    if (!res.ok || !/html|xml/i.test(ctype)) return undefined;
    const charset = /charset=([\w-]+)/i.exec(ctype)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString("latin1"))?.[1];
    let html: string;
    try {
      html = new TextDecoder(charset ?? "utf-8").decode(buf);
    } catch {
      html = buf.toString("utf8");
    }
    return { html, finalUrl };
  } catch {
    return undefined;
  }
}

/** og:image / twitter:image of an article page, as an absolute public https URL (undefined if none). */
export function parseArticleMetaImage(html: string, baseUrl: string): string | undefined {
  const m = metaTags(html);
  for (const key of ["og:image", "og:image:secure_url", "og:image:url", "twitter:image", "twitter:image:src"]) {
    const v = m[key];
    if (!v) continue;
    try {
      const abs = new URL(v, baseUrl).toString();
      if (isPublicUrl(abs)) return abs;
    } catch {
      /* next key */
    }
  }
  return undefined;
}
