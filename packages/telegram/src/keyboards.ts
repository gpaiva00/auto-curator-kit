import type { Destination, RejectReason } from "@auto-curator/contracts";
import type { InlineKeyboard } from "./api.js";
import { platformName } from "./messages.js";
import { S } from "./strings.js";

export type CallbackAct = "a" | "r" | "rj" | "b" | "eb" | "eh" | "rg" | "p";

/** Telegram caps callback_data at 64 bytes. */
export function cb(act: CallbackAct, id: string, arg?: string): string {
  const data = arg === undefined ? `${act}|${id}` : `${act}|${id}|${arg}`;
  if (Buffer.byteLength(data) > 64) throw new Error(`callback data too long (${Buffer.byteLength(data)}B): ${data}`);
  return data;
}

export function parseCallback(data: string | undefined): { act: string; id: string; arg?: string } | undefined {
  const [act, id, ...rest] = (data ?? "").split("|");
  if (!act || !id) return undefined;
  return { act, id, arg: rest.length ? rest.join("|") : undefined };
}

export function approvalKeyboard(id: string): InlineKeyboard {
  return [
    [
      { text: S.btnApprove, callback_data: cb("a", id) },
      { text: S.btnReject, callback_data: cb("r", id) },
    ],
    [
      { text: S.btnEditBody, callback_data: cb("eb", id) },
      { text: S.btnEditHeadline, callback_data: cb("eh", id) },
    ],
    [{ text: S.btnRegenerate, callback_data: cb("rg", id) }],
  ];
}

/** Reasons two per row, then "Voltar". */
export function reasonsKeyboard(id: string, reasons: RejectReason[]): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < reasons.length; i += 2) rows.push(reasons.slice(i, i + 2).map((r) => ({ text: r.label, callback_data: cb("rj", id, r.code) })));
  rows.push([{ text: S.btnBack, callback_data: cb("b", id) }]);
  return rows;
}

/** One row per manual platform: open the app (when composeUrl is set) and confirm publication. */
export function manualKeyboard(id: string, platforms: string[], destinations: Destination[]): InlineKeyboard {
  return platforms.map((p) => {
    const row: InlineKeyboard[number] = [];
    const url = destinations.find((d) => d.platform === p)?.composeUrl;
    if (url) row.push({ text: S.btnOpen(platformName(p)), url });
    row.push({ text: S.btnPublished(platformName(p)), callback_data: cb("p", id, p) });
    return row;
  });
}
