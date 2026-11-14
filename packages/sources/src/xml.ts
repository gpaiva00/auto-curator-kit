/** Tiny, dependency-free XML helpers, good enough for RSS/Atom/Google Trends feeds. */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function textOf(raw: string): string {
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw.trim());
  return (cdata ? cdata[1]! : decodeEntities(raw)).trim();
}

const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");

/** Returns the inner XML of every <tag ...>...</tag> block (self-closing tags are ignored). */
export function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${esc(tag)}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</${esc(tag)}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]!);
  return out;
}

export function tagText(xml: string, tag: string): string | undefined {
  const b = blocks(xml, tag)[0];
  return b === undefined ? undefined : textOf(b);
}

/** Every opening tag `<tag ...>` / `<tag ... />` as a map of its attributes (decoded). */
export function tags(xml: string, tag: string): Record<string, string>[] {
  const re = new RegExp(`<${esc(tag)}(\\s[^>]*)?/?>`, "gi");
  const out: Record<string, string>[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(attrsOf(m[1] ?? ""));
  return out;
}

export function attrsOf(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? "");
  return attrs;
}

/** Attribute of the first <tag attr="..."> (self-closing or not). */
export function tagAttr(xml: string, tag: string, attr: string): string | undefined {
  for (const a of tags(xml, tag)) if (a[attr.toLowerCase()] !== undefined) return a[attr.toLowerCase()];
  return undefined;
}

export function stripHtml(s: string): string {
  const noCdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return decodeEntities(noCdata.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
