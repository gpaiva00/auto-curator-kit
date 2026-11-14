import { parseArticleMetaImage, readHtml } from "./page.js";
import { BROWSER_UA, isPublicUrl } from "./util.js";

export { parseArticleMetaImage as parseArticleImage } from "./page.js";

const isGoogleNews = (u: string): boolean => {
  try {
    return new URL(u).hostname === "news.google.com";
  } catch {
    return false;
  }
};
export { isGoogleNews };

/**
 * Google News RSS links are opaque redirects. The article page carries id/timestamp/signature that Google's own
 * (undocumented) endpoint turns back into the publisher URL. Best effort: any change on Google's side => undefined.
 */
export async function resolveGoogleNewsUrl(url: string, f: typeof fetch, timeoutMs: number): Promise<string | undefined> {
  const page = await readHtml(url, f, { timeoutMs });
  if (!page) return undefined;
  const id = /data-n-a-id="([^"]+)"/.exec(page.html)?.[1];
  const ts = /data-n-a-ts="(\d+)"/.exec(page.html)?.[1];
  const sg = /data-n-a-sg="([^"]+)"/.exec(page.html)?.[1];
  if (!id || !ts || !sg) return undefined;
  const inner = JSON.stringify(["garturlreq", [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]);
  const body = new URLSearchParams({ "f.req": JSON.stringify([[["Fbv4je", inner, null, "generic"]]]) });
  try {
    const res = await f("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": BROWSER_UA },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const real = /garturlres\\",\\"(https?:[^"\\]+)/.exec(await res.text())?.[1];
    return real && isPublicUrl(real) && !isGoogleNews(real) ? real : undefined;
  } catch {
    return undefined;
  }
}

export interface ArticleEnrichment {
  /** Publisher URL when the feed link was a Google News redirect that could be resolved. */
  url?: string;
  imageUrl?: string;
}

/** Finds the article's own og:image (resolving Google News links first). Never throws. */
export async function enrichArticle(link: string, f: typeof fetch, timeoutMs: number, opts: { needImage: boolean }): Promise<ArticleEnrichment> {
  let articleUrl: string | undefined = link;
  let resolved: string | undefined;
  if (isGoogleNews(link)) {
    resolved = await resolveGoogleNewsUrl(link, f, timeoutMs);
    articleUrl = resolved;
  }
  if (!articleUrl || !opts.needImage) return { url: resolved };
  const page = await readHtml(articleUrl, f, { timeoutMs });
  const imageUrl = page ? parseArticleMetaImage(page.html, page.finalUrl) : undefined;
  return { url: resolved, imageUrl };
}
