import { errMsg, silentLogger, type ApprovalUiConfig, type BotActions, type Draft, type Item, type PreparedMedia, type Logger, type Notifier, type Status, type StorePort } from "@auto-curator/contracts";
import { TelegramApi, TelegramError, type InlineKeyboard, type Update } from "./api.js";
import { BOT_COMMANDS, menuCommands, resolveCommand, type CommandName } from "./commands.js";
import { approvalKeyboard, manualKeyboard, parseCallback, reasonsKeyboard } from "./keyboards.js";
import { agendaText, approvalText, finalText, helpText, outcomeText, pendingText, postLabel, queueText, statusText } from "./messages.js";
import { S } from "./strings.js";

export { BOT_COMMANDS };

export const KV_OFFSET = "tg_offset";
export const KV_AWAIT = "tg_await";
export const MAX_BODY = 5000;
export const MAX_HEADLINE = 200;

export interface BotDeps {
  api: TelegramApi;
  /**
   * Chats allowed to use the bot. The first is the primary chat (message ids are tracked for it).
   * SECURITY: authorization is per CHAT id. In a group or channel every member can approve and publish,
   * so use a private chat with the bot (or set `allowedUserIds` as a second factor).
   */
  allowedChatIds: string[];
  /** Optional: when non-empty, the sender's user id (from.id) must also be in this list. */
  allowedUserIds?: string[];
  store: StorePort;
  actions: BotActions;
  ui: ApprovalUiConfig;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

const QUEUE_STATUSES: Status[] = ["new", "scored", "curated", "ready", "pending_approval", "approved"];
const URL_ONLY = /^https?:\/\/\S+$/i;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type CallbackQuery = NonNullable<Update["callback_query"]>;

export class TelegramBot implements Notifier {
  private readonly log: Logger;
  private abort?: AbortController;
  private loop?: Promise<void>;
  private readonly detached = new Set<Promise<void>>();
  private failFn!: (e: Error) => void;
  /** Resolves when polling stopped for a reason that needs the operator (e.g. another poller uses the token). */
  readonly failed: Promise<Error> = new Promise((r) => (this.failFn = r));

  constructor(private readonly d: BotDeps) {
    this.log = d.logger ?? silentLogger;
    if (d.allowedChatIds.length === 0) throw new Error("TelegramBot needs at least one allowed chat id");
  }

  private get primary(): string {
    return this.d.allowedChatIds[0]!;
  }

  // ------------------------------------------------------------------ Notifier

  async notify(text: string): Promise<void> {
    await this.broadcast((chat) => this.d.api.sendMessage(chat, text));
  }

  async sendApproval(item: Item): Promise<number[]> {
    const ids = await this.broadcast(async (chat) => {
      const sent: number[] = [];
      const label = postLabel(item);
      const media = item.prepared;
      try {
        for (const [i, m] of media.entries()) sent.push((await this.d.api.sendMedia(chat, m, S.mediaCaption(label, i + 1, media.length))).message_id);
        sent.push((await this.d.api.sendMessage(chat, approvalText(item, this.d.ui), { reply_markup: { inline_keyboard: approvalKeyboard(item.id) } })).message_id);
      } catch (e) {
        // never leave orphan media behind: the whole card is re-sent on the next tick
        if (sent.length) await this.d.api.deleteMessages(chat, sent).catch(() => {});
        throw e;
      }
      return sent;
    });
    this.d.store.setTelegramMsgs(item.id, ids);
    return ids;
  }

  /** Runs `send` for every allowed chat; returns the primary chat's result (its failure is rethrown). */
  private async broadcast<T>(send: (chat: string) => Promise<T>): Promise<T> {
    const chats = this.d.allowedChatIds;
    const results = await Promise.allSettled(chats.map((c) => send(c)));
    results.forEach((r, i) => {
      if (r.status === "rejected") this.log.warn(`telegram send to chat ${chats[i]} failed: ${errMsg(r.reason)}`);
    });
    const first = results[0]!;
    if (first.status === "rejected") throw first.reason;
    return first.value;
  }

  private async deleteMessages(ids: number[]): Promise<void> {
    if (!ids.length) return;
    try {
      await this.d.api.deleteMessages(this.primary, ids);
    } catch (e) {
      this.log.warn(`telegram delete failed: ${errMsg(e)}`);
    }
  }

  private reply(chat: string, text: string, kb?: InlineKeyboard) {
    return this.d.api.sendMessage(chat, text, kb ? { reply_markup: { inline_keyboard: kb } } : {});
  }

  // ------------------------------------------------------------------ polling

  /** One getUpdates round; returns how many updates were handled. */
  async pollOnce(timeoutSec = 30, signal?: AbortSignal): Promise<number> {
    const offset = Number(this.d.store.kvGet(KV_OFFSET) ?? "0");
    const updates = await this.d.api.getUpdates(offset, timeoutSec, signal);
    for (const u of updates) {
      this.d.store.kvSet(KV_OFFSET, String(u.update_id + 1)); // persist first: never reprocess after a crash
      await this.handleUpdate(u);
    }
    return updates.length;
  }

  /** Registers the "/" menu and starts the long-polling loop in the background. */
  async start(): Promise<void> {
    if (this.loop) return;
    try {
      await this.d.api.getMe();
    } catch (e) {
      if (e instanceof TelegramError && (e.status === 401 || e.status === 404)) {
        throw new Error("Token do Telegram inválido (HTTP " + e.status + "). Confira TELEGRAM_BOT_TOKEN no .env do perfil.");
      }
      this.log.warn(`getMe failed: ${errMsg(e)}`);
    }
    this.abort = new AbortController();
    const { signal } = this.abort;
    try {
      await this.d.api.setMyCommands(menuCommands());
    } catch (e) {
      this.log.warn(`setMyCommands failed: ${errMsg(e)}`);
    }
    const sleep = this.d.sleep ?? realSleep;
    this.loop = (async () => {
      let backoff = 2000;
      while (!signal.aborted) {
        try {
          await this.pollOnce(30, signal);
          backoff = 2000;
        } catch (e) {
          if (signal.aborted) break;
          if (e instanceof TelegramError && e.status === 409) {
            const msg = "Conflito no Telegram (409): outro processo já está lendo as mensagens deste bot. Pare a outra instância e reinicie.";
            this.log.error(msg);
            this.failFn(new Error(msg));
            break;
          }
          this.log.warn(`telegram poll failed: ${errMsg(e)}`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    })();
  }

  /** Runs a long action off the poll loop; failures are reported to the chat. Tracked so stop() can wait for it. */
  private detach(chat: string, fn: () => Promise<void>): void {
    const p: Promise<void> = fn()
      .catch(async (e) => {
        this.log.error(`background action failed: ${errMsg(e)}`);
        await this.reply(chat, S.error(errMsg(e))).catch(() => {});
      })
      .finally(() => void this.detached.delete(p));
    this.detached.add(p);
  }

  /** Resolves when every detached action has finished (used by stop() and tests). */
  async settle(): Promise<void> {
    while (this.detached.size) await Promise.all([...this.detached]);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.loop?.catch(() => {});
    await this.settle();
    this.loop = undefined;
    this.abort = undefined;
  }

  // ------------------------------------------------------------------ updates

  async handleUpdate(u: Update): Promise<void> {
    const chat = String(u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? "");
    if (!this.d.allowedChatIds.includes(chat)) {
      this.log.warn(`ignoring update from unauthorized chat ${chat}`);
      return;
    }
    const users = this.d.allowedUserIds;
    if (users?.length) {
      const from = u.message?.from?.id ?? u.callback_query?.from?.id;
      if (from === undefined || !users.includes(String(from))) {
        this.log.warn(`ignoring update from unauthorized user ${from ?? "?"}`);
        return;
      }
    }
    try {
      if (u.callback_query) await this.onCallback(u.callback_query, chat);
      else if (u.message?.text) await this.onText(u.message.text, chat);
    } catch (e) {
      this.log.error(`update handler failed: ${errMsg(e)}`);
      await this.reply(chat, S.error(errMsg(e))).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ text

  private async onText(text: string, chat: string): Promise<void> {
    const t = text.trim();
    const awaiting = this.d.store.kvGet(KV_AWAIT);
    // "/igual" is the answer to a pending "refazer", not a command
    if (awaiting?.startsWith("regen:") && /^\/igual(@\w+)?$/i.test(t)) return this.onAwaited(awaiting, "", chat);

    const m = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(t);
    if (m) {
      if (awaiting) this.d.store.kvDel(KV_AWAIT); // any command cancels the pending input
      const cmd = resolveCommand(m[1]!);
      if (!cmd) return void (await this.reply(chat, S.unknownCommand));
      return this.onCommand(cmd, (m[2] ?? "").trim(), chat, !!awaiting);
    }
    if (t.startsWith("/")) return void (await this.reply(chat, S.unknownCommand));
    if (awaiting) return this.onAwaited(awaiting, t, chat);
    if (URL_ONLY.test(t)) return this.cmdAdd(t, chat);
    await this.reply(chat, S.notUnderstood);
  }

  private async onCommand(cmd: CommandName, arg: string, chat: string, hadAwait: boolean): Promise<void> {
    const { actions, store } = this.d;
    switch (cmd) {
      case "add":
        return this.cmdAdd(arg, chat);
      case "ler":
        await this.reply(chat, S.reading);
        return this.detach(chat, async () => {
          await this.reply(chat, await actions.ingestNow().catch((e) => S.readingFailed(errMsg(e))));
        });
      case "pendentes":
        return void (await this.reply(chat, pendingText(store.list("pending_approval", 200))));
      case "fila":
        return void (await this.reply(chat, queueText(store.list(QUEUE_STATUSES, 200))));
      case "agenda":
        return void (await this.reply(chat, agendaText(await actions.agenda(), this.d.ui.timezone)));
      case "furar":
      case "desfurar": {
        if (!arg) return void (await this.reply(chat, S.idUsage(cmd)));
        const id = arg.split(/\s+/)[0]!;
        const item = store.get(id);
        if (!item) return void (await this.reply(chat, S.unknownId(id)));
        store.setPriority(id, cmd === "furar" ? 100 : 0);
        return void (await this.reply(chat, cmd === "furar" ? S.bumped(postLabel(item)) : S.unbumped(postLabel(item))));
      }
      case "status":
        return void (await this.reply(chat, statusText(actions.status())));
      case "pausar":
        actions.setPaused(true);
        return void (await this.reply(chat, S.paused));
      case "retomar":
        actions.setPaused(false);
        return void (await this.reply(chat, S.resumed));
      case "cancelar":
        return void (await this.reply(chat, hadAwait ? S.cancelled : S.nothingToCancel));
      case "ajuda":
        return void (await this.reply(chat, helpText()));
    }
  }

  private async cmdAdd(input: string, chat: string): Promise<void> {
    if (!input) return void (await this.reply(chat, S.addUsage));
    this.detach(chat, async () => {
      const r = await this.d.actions.addManual(input);
      if (!r.item) return void (await this.reply(chat, S.addFailed(r.error ?? "motivo desconhecido")));
      await this.reply(chat, S.added(postLabel(r.item)));
      await this.d.actions.runPipeline();
    });
  }

  /** The user's reply to "send me the new text / instruction". */
  private async onAwaited(state: string, text: string, chat: string): Promise<void> {
    const { store, actions } = this.d;
    const [kind, id] = [state.slice(0, state.indexOf(":")), state.slice(state.indexOf(":") + 1)];
    store.kvDel(KV_AWAIT);
    const item = store.get(id);
    if (!item) return void (await this.reply(chat, S.unknownId(id)));
    if (item.status !== "pending_approval") return void (await this.reply(chat, S.toastAlready(item.status)));
    const label = postLabel(item);
    if (kind === "body" || kind === "head") {
      if (!item.draft) return void (await this.reply(chat, S.unknownId(id)));
      const draft: Draft = kind === "body" ? { ...item.draft, body: text.slice(0, MAX_BODY) } : { ...item.draft, headline: text.slice(0, MAX_HEADLINE) };
      store.setDraft(id, draft);
      store.recordApproval(id, kind === "body" ? "edit_body" : "edit_headline");
      await this.reply(chat, kind === "body" ? S.bodyUpdated(label) : S.headlineUpdated(label));
      this.detach(chat, () => this.replaceCard(item, () => actions.reprepare(id)));
    } else if (kind === "regen") {
      await this.reply(chat, S.regenerating(label));
      this.detach(chat, () => this.replaceCard(item, () => actions.regenerate(id, text || undefined)));
    }
  }

  /** Runs an action that re-sends the approval card, then deletes the stale cards (their buttons would still act on the item). */
  private async replaceCard(item: Item, action: () => Promise<void>): Promise<void> {
    const old = [...item.telegramMsgIds];
    await action();
    const fresh = new Set(this.d.store.get(item.id)?.telegramMsgIds ?? []);
    await this.deleteMessages(old.filter((m) => !fresh.has(m)));
  }

  // ------------------------------------------------------------------ callbacks

  /** Cosmetic: Telegram rejects stale queries; must never block the action behind the button. */
  private async ack(id: string, text?: string): Promise<void> {
    try {
      await this.d.api.answerCallbackQuery(id, text);
    } catch (e) {
      this.log.warn(`answerCallbackQuery ignored: ${errMsg(e)}`);
    }
  }

  private async onCallback(q: CallbackQuery, chat: string): Promise<void> {
    const cb = parseCallback(q.data);
    if (!cb) return void (await this.ack(q.id, S.toastInvalid));
    const { act, id, arg } = cb;
    const mid = q.message?.message_id;
    const { store, actions } = this.d;
    const item = store.get(id);
    if (!item) return void (await this.ack(q.id, S.toastNotFound));
    const label = postLabel(item);

    // p (mark published) works after approval; every other button needs a pending item
    if (["a", "r", "rj", "b", "eb", "eh", "rg"].includes(act) && item.status !== "pending_approval") {
      await this.ack(q.id, S.toastAlready(item.status));
      if (mid) await this.d.api.setInlineKeyboard(chat, mid, []).catch(() => {});
      return;
    }

    switch (act) {
      case "a": {
        await this.ack(q.id, S.toastApproving);
        const outcomes = await actions.approve(id);
        // approved posts leave the chat; only a failure (needs the user's attention) is kept as a message
        await this.deleteMessages(item.telegramMsgIds);
        const fresh = store.get(id) ?? item;
        if (outcomes.some((o) => o.kind === "failed")) await this.reply(chat, outcomeText(fresh, outcomes, this.d.ui.timezone));
        const manual = outcomes.filter((o) => o.kind !== "buffer").map((o) => o.platform);
        if (manual.length) await this.sendManual(chat, fresh, manual);
        return;
      }
      case "r":
        await this.ack(q.id);
        if (mid) await this.d.api.setInlineKeyboard(chat, mid, reasonsKeyboard(id, this.d.ui.rejectReasons));
        return;
      case "b":
        await this.ack(q.id);
        if (mid) await this.d.api.setInlineKeyboard(chat, mid, approvalKeyboard(id));
        return;
      case "rj": {
        const reason = this.d.ui.rejectReasons.find((r) => r.code === arg);
        if (!reason) return void (await this.ack(q.id, S.toastBadReason));
        await this.ack(q.id, S.toastRejected);
        await actions.reject(id, reason.code);
        await this.deleteMessages(item.telegramMsgIds);
        return;
      }
      case "eb":
        store.kvSet(KV_AWAIT, `body:${id}`);
        await this.ack(q.id);
        return void (await this.reply(chat, S.askBody(label, MAX_BODY)));
      case "eh":
        store.kvSet(KV_AWAIT, `head:${id}`);
        await this.ack(q.id);
        return void (await this.reply(chat, S.askHeadline(label, MAX_HEADLINE)));
      case "rg":
        store.kvSet(KV_AWAIT, `regen:${id}`);
        await this.ack(q.id);
        return void (await this.reply(chat, S.askRegen(label)));
      case "p": {
        if (!arg) return void (await this.ack(q.id, S.toastInvalid));
        await this.ack(q.id, S.toastPublished);
        await actions.markPublished(id, arg);
        if (mid) await this.d.api.setInlineKeyboard(chat, mid, []).catch(() => {});
        return void (await this.reply(chat, S.published(label, arg)));
      }
      default:
        await this.ack(q.id, S.toastInvalid);
    }
  }

  /** Final media + copy-paste text + "Abrir / Publiquei" buttons for the platforms the human must post. */
  private async sendManual(chat: string, item: Item, platforms: string[]): Promise<void> {
    const label = postLabel(item);
    const media = manualMedia(item.prepared, platforms);
    for (const [i, m] of media.entries()) await this.d.api.sendMedia(chat, m, S.finalMediaCaption(label, i + 1, media.length));
    await this.reply(chat, finalText(item, this.d.ui, platforms), manualKeyboard(item.id, platforms, this.d.ui.destinations));
  }
}

/** Same rule as the engine: per platform, its own variants when they exist, else the generic media; no duplicates. */
function manualMedia(prepared: PreparedMedia[], platforms: string[]): PreparedMedia[] {
  const out = new Set<PreparedMedia>();
  for (const p of platforms) {
    const own = prepared.filter((m) => m.platform === p);
    for (const m of own.length ? own : prepared.filter((m) => !m.platform)) out.add(m);
  }
  return [...out];
}
