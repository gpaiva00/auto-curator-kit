import { attrsOf, decodeEntities, stripHtml } from "./xml.js";

/** First value of each `<meta property|name=... content=...>` (keys lower-cased). */
export function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const a = attrsOf(tag.slice(5));
    const key = (a.property ?? a.name ?? "").toLowerCase();
    if (key && a.content !== undefined && out[key] === undefined) out[key] = a.content.trim();
  }
  return out;
}

export function pageTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? stripHtml(m[1]!) : "";
  return t || undefined;
}

/** Best-effort article body: the <p> blocks (>= 40 chars) of <article>, else <main>, else <body>. */
export function articleText(html: string, max = 6000): string {
  const clean = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|template)\b[\s\S]*?<\/\1>/gi, " ");
  const area = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(clean)?.[1] ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(clean)?.[1] ?? /<body\b[^>]*>([\s\S]*)/i.exec(clean)?.[1] ?? clean;
  const paras: string[] = [];
  for (const m of area.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = stripHtml(m[1]!);
    if (t.length >= 40) paras.push(t);
  }
  return paras.join("\n\n").slice(0, max);
}

export const decodeAttr = decodeEntities;
