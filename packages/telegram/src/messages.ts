import { composeText, type ApprovalUiConfig, type DestinationOutcome, type Item, type SettingView, type StatusSnapshot } from "@auto-curator/contracts";
import { BOT_COMMANDS } from "./commands.js";
import { S } from "./strings.js";

// ------------------------------------------------------------------ layout helpers

/** Joins non-empty parts with a blank line. */
export function block(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join("\n\n");
}
export const bullets = (items: string[]): string => items.map((i) => `• ${i}`).join("\n");

export const trunc = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

/** "09/11 às 13:15" in `timeZone`. */
export function whenText(at: Date | string, timeZone: string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${date} às ${time}`;
}

const itemHeadline = (item: Item): string => item.draft?.headline ?? item.title ?? trunc(item.text, 60);

/** How an item is named in messages: id plus a short headline. */
export function postLabel(item: { id: string; draft?: { headline: string } | null; title?: string | null; text?: string }): string {
  const title = (item.draft?.headline ?? item.title ?? item.text ?? "").trim();
  return title ? `${item.id} · ${trunc(title, 60)}` : item.id;
}

export function platformName(p: string): string {
  const known: Record<string, string> = { instagram: "Instagram", linkedin: "LinkedIn", tiktok: "TikTok", threads: "Threads", x: "X" };
  const k = p.toLowerCase();
  return known[k] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : p);
}

const destinationNames = (ui: ApprovalUiConfig): string => [...new Set(ui.destinations.map((d) => platformName(d.platform)))].join(" + ");

// ------------------------------------------------------------------ approval card

export function approvalText(item: Item, ui: ApprovalUiConfig): string {
  const d = item.draft;
  const review = !!d && (d.verdict === "needs_human" || d.riskFlags.length > 0);
  const head = `${review ? S.headerReview : S.headerNew} · ${item.id} · ${trunc(itemHeadline(item), 60)}`;
  const stats = d
    ? [S.confidence(Math.round(d.confidence * 100)), S.destinations(destinationNames(ui)), S.risks(d.riskFlags.length ? d.riskFlags.join(", ") : S.noRisks)].join(" · ")
    : undefined;
  const doubt = d?.skipReason || d?.notes;
  const third = item.prepared.filter((m) => m.thirdParty).length;
  const media = third > 0 ? S.thirdPartyMedia(third) : item.prepared.length === 0 ? (item.media.length === 0 ? S.textOnly : S.noPreparedMedia) : undefined;
  const credit = ui.credit === "show" ? d?.sourceCredit?.trim() : undefined;
  const source = [item.sourceUrl ? S.source(item.sourceUrl) : undefined, credit ? S.credit(credit) : undefined].filter(Boolean).join("  ·  ");
  const info = [head, stats, doubt ? S.doubt(doubt) : undefined, media, source || undefined].filter(Boolean).join("\n");
  const text = d ? composeText(d, { credit: ui.credit }) : trunc(item.text, 1000);
  return block(info, `${S.separator}\n${text}`, d?.firstComment ? S.firstComment(d.firstComment) : undefined);
}

/** Copy-paste message for manual platforms. */
export function finalText(item: Item, ui: ApprovalUiConfig, platforms: string[]): string {
  const text = item.draft ? composeText(item.draft, { credit: ui.credit }) : item.text;
  const fc = item.draft?.firstComment;
  return block(S.finalHeader(platforms.map(platformName).join(" + "), postLabel(item)), text, fc ? S.firstComment(fc) : undefined, S.finalHint);
}

export function outcomeText(item: Item, outcomes: DestinationOutcome[], tz: string): string {
  const lines: string[] = [];
  for (const o of outcomes) {
    const p = platformName(o.platform);
    if (o.kind === "manual") lines.push(S.outcomeManual(p) + (o.error ? ` (${o.error})` : ""));
    else if (o.kind === "failed") lines.push(S.outcomeFailed(p, o.error ?? "erro desconhecido"));
    else if (o.scheduledAt) lines.push(S.outcomeScheduled(p, whenText(o.scheduledAt, tz)));
    else lines.push(o.mode === "queue" ? S.outcomeBufferQueue(p) : o.mode === "now" ? S.outcomeBufferNow(p) : S.outcomeBufferDraft(p));
    if (o.droppedMedia) lines.push(S.outcomeDropped(o.droppedMedia));
  }
  return block(S.outcomeHeader(postLabel(item)), lines.join("\n"));
}

export function skipNotice(item: Item, reason?: string): string {
  return block(S.skipTitle(postLabel(item)), reason ? S.skipReason(reason) : undefined);
}

// ------------------------------------------------------------------ lists

const LIST_ORDER = ["new", "scored", "curated", "ready", "pending_approval", "approved"] as const;

export function pendingText(items: Item[], limit = 25): string {
  if (items.length === 0) return S.pendingEmpty;
  const rows = items.slice(0, limit).map((i) => `${i.draft?.verdict === "needs_human" ? "⚠️" : "•"} ${postLabel(i)}`);
  return block(S.pendingTitle(items.length), rows.join("\n"), items.length > limit ? S.more(items.length - limit) : undefined);
}

export function queueText(items: Item[], perGroup = 15): string {
  if (items.length === 0) return S.queueEmpty;
  const groups = LIST_ORDER.map((st) => {
    const list = items.filter((i) => i.status === st);
    if (!list.length) return undefined;
    const rows = list.slice(0, perGroup).map((i) => `${i.priority > 0 ? "⭐ " : ""}${postLabel(i)}`);
    return `${S.statusLabels[st]} (${list.length})\n${bullets(rows)}${list.length > perGroup ? `\n${S.more(list.length - perGroup)}` : ""}`;
  });
  return block(S.queueTitle(items.length), ...groups);
}

export function agendaText(entries: { platform: string; label: string; scheduledAt?: string }[], tz: string): string {
  if (entries.length === 0) return S.agendaEmpty;
  const sorted = [...entries].sort((a, b) => (a.scheduledAt ?? "9").localeCompare(b.scheduledAt ?? "9"));
  const rows = sorted.map((e) => `${e.scheduledAt ? whenText(e.scheduledAt, tz) : S.noDate} · ${platformName(e.platform)} · ${trunc(e.label, 70)}`);
  return block(S.agendaTitle(entries.length), bullets(rows));
}

export function statusText(s: StatusSnapshot): string {
  const counts = Object.entries(s.counts).filter(([, n]) => n);
  const countLines = counts.length ? bullets(counts.map(([st, n]) => `${S.statusLabels[st] ?? st}: ${n}`)) : S.statusCountsNone;
  return block(
    S.statusTitle(s.profileName),
    s.paused ? S.statusPaused : S.statusRunning,
    countLines,
    [S.statusToday(s.presentedToday, s.dailyApprovalCap), S.statusSpend(s.spendBRL.toFixed(2), s.budgetBRL.toFixed(2))].join("\n"),
    s.gate ? S.statusGate(s.gate) : undefined,
  );
}

export function configText(views: SettingView[]): string {
  return block(
    S.configTitle,
    bullets(views.map((v) => `/definir ${v.key} <valor> — ${v.label}: ${v.value}`)),
  );
}

export function helpText(): string {
  return block(
    S.helpTitle,
    bullets(BOT_COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""} — ${c.description}${c.aliases.length ? ` (${c.aliases.map((a) => `/${a}`).join(", ")})` : ""}`)),
  );
}
