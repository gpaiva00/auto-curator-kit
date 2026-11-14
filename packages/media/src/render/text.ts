/**
 * Text sanitation. Emoji policy: satori needs per-emoji image assets (fetched from the network)
 * to draw emoji, and Inter has no emoji glyphs. We run offline, so emoji are STRIPPED.
 * e.g. "🚨 VEJA: ..." -> "VEJA: ...". Diacritics (pt-BR) are kept (NFC normalized).
 */
const EMOJI_RE =
  /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‌⁠﻿‪-‮]/g;

export function sanitizeText(input: string): string {
  return input
    .normalize("NFC")
    .replace(EMOJI_RE, "")
    .replace(CONTROL_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

/** Break absurdly long unbroken tokens (URLs etc.) so they cannot overflow a line. */
export function breakLongTokens(text: string, maxToken = 24): string {
  return text
    .split(" ")
    .map((w) => (w.length > maxToken ? w.slice(0, maxToken - 1) + "…" : w))
    .join(" ");
}

export function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Readable text color (black/white) on top of the given background color. */
export function readableOn(bg: string): string {
  const rgb = parseHex(bg);
  if (!rgb) return "#111111";
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? "#111111" : "#FFFFFF";
}

/** Keeps only [A-Za-z0-9_-] so the id is safe as a file name. */
export function safeId(id: string): string {
  const s = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return s.length ? s : "post";
}
