import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

export class TelegramError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "TelegramError";
  }
}

type Json = Record<string, unknown>;

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}
export type InlineKeyboard = InlineButton[][];

export interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number | string }; from?: { id: number | string }; text?: string };
  callback_query?: { id: string; data?: string; from?: { id: number | string }; message?: { message_id: number; chat: { id: number | string } } };
}

export interface MediaFile {
  type: "image" | "video";
  localPath: string;
  width?: number;
  height?: number;
}

export const MAX_TEXT = 4096;
export const MAX_CAPTION = 1024;

/** Clips to `max` chars, ending in an ellipsis when something was cut. */
export const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm"]);

/** Thin Bot API client over fetch (outbound only: long polling, no webhook, no deps). Plain text, never parse_mode. */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly f: typeof fetch = fetch,
    private readonly base = "https://api.telegram.org",
  ) {}

  private url(method: string) {
    return `${this.base}/bot${this.token}/${method}`;
  }

  async call<T = unknown>(method: string, params: Json = {}, timeoutMs = 20_000, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await this.f(this.url(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    return this.parse<T>(res, method);
  }

  private async form<T>(method: string, form: FormData): Promise<T> {
    const res = await this.f(this.url(method), { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
    return this.parse<T>(res, method);
  }

  private async parse<T>(res: Response, method: string): Promise<T> {
    let body: { ok?: boolean; result?: T; description?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON */
    }
    if (!res.ok || !body.ok) throw new TelegramError(`Telegram ${method} failed: ${body.description ?? res.status}`, res.status);
    return body.result as T;
  }

  /** Validates the token: rejects with TelegramError (status 401/404) when it is wrong. */
  getMe() {
    return this.call<{ id: number; username?: string }>("getMe");
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal) {
    return this.call<Update[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, (timeoutSec + 15) * 1000, signal);
  }

  sendMessage(chatId: string, text: string, extra: { reply_markup?: { inline_keyboard: InlineKeyboard } } & Json = {}) {
    return this.call<{ message_id: number }>("sendMessage", { chat_id: chatId, text: clip(text, MAX_TEXT), disable_web_page_preview: true, ...extra });
  }

  async sendPhoto(chatId: string, path: string, caption = "") {
    return this.upload<{ message_id: number }>("sendPhoto", "photo", path, { chat_id: chatId, caption: clip(caption, MAX_CAPTION) });
  }

  /** width/height matter: Telegram's preview squashes videos sent without them. */
  async sendVideo(chatId: string, path: string, caption = "", size: { width?: number; height?: number } = {}) {
    const fields: Record<string, string> = { chat_id: chatId, caption: clip(caption, MAX_CAPTION), supports_streaming: "true" };
    if (size.width && size.height) Object.assign(fields, { width: String(size.width), height: String(size.height) });
    return this.upload<{ message_id: number }>("sendVideo", "video", path, fields);
  }

  /** Sends one prepared file; a photo Telegram refuses (size/dimensions) falls back to a document so nothing is lost. */
  async sendMedia(chatId: string, m: MediaFile, caption = ""): Promise<{ message_id: number }> {
    const isVideo = m.type === "video" || VIDEO_EXT.has(extname(m.localPath).toLowerCase());
    if (isVideo) return this.sendVideo(chatId, m.localPath, caption, m);
    try {
      return await this.sendPhoto(chatId, m.localPath, caption);
    } catch {
      return this.upload("sendDocument", "document", m.localPath, { chat_id: chatId, caption: clip(caption, MAX_CAPTION) });
    }
  }

  /** Album of 2-10 local files. Only the first caption is shown by Telegram. */
  async sendMediaGroup(chatId: string, files: MediaFile[], caption = "") {
    const form = new FormData();
    form.set("chat_id", chatId);
    const media: Json[] = [];
    for (const [i, m] of files.entries()) {
      const name = `file${i}`;
      form.set(name, new Blob([await readFile(m.localPath)]), basename(m.localPath));
      media.push({ type: m.type === "video" ? "video" : "photo", media: `attach://${name}`, ...(i === 0 && caption ? { caption: clip(caption, MAX_CAPTION) } : {}) });
    }
    form.set("media", JSON.stringify(media));
    return this.form<{ message_id: number }[]>("sendMediaGroup", form);
  }

  private async upload<T>(method: string, fileField: string, path: string, fields: Record<string, string>): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set(fileField, new Blob([await readFile(path)]), basename(path));
    return this.form<T>(method, form);
  }

  deleteMessage(chatId: string, messageId: number) {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  /** Deletes up to 100 messages at once (the bot can only delete its own messages younger than 48h). */
  async deleteMessages(chatId: string, ids: number[]) {
    for (let i = 0; i < ids.length; i += 100) await this.call("deleteMessages", { chat_id: chatId, message_ids: ids.slice(i, i + 100) });
  }

  setInlineKeyboard(chatId: string, messageId: number, rows: InlineKeyboard) {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
  }

  answerCallbackQuery(id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: clip(text, 200) } : {}) });
  }

  /** Registers the "/" menu shown by Telegram clients. */
  setMyCommands(commands: readonly { command: string; description: string }[]) {
    return this.call("setMyCommands", { commands });
  }
}
