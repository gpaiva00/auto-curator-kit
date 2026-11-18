import { describe, expect, it } from "vitest";
import { BOT_COMMANDS, KV_AWAIT, KV_OFFSET, TelegramError } from "../src/index.js";
import { draft, item, setup, tmpFile } from "./helpers.js";

describe("access and polling", () => {
  it("ignores unauthorized chats (text and callbacks)", async () => {
    const t = setup();
    t.store.add(item());
    await t.text("/status", 999);
    await t.press("a|p_ab12", 999);
    expect(t.net.calls).toHaveLength(0);
    expect(t.actions.log).toEqual([]);
  });

  it("pollOnce persists offset before handling and tolerates handler errors", async () => {
    const t = setup();
    t.actions.ingestNow = async () => {
      throw new Error("boom");
    };
    t.net.updates.push([{ update_id: 7, message: { message_id: 1, chat: { id: 1 }, text: "/ler" } }, { update_id: 8, message: { message_id: 2, chat: { id: 1 }, text: "/status" } }]);
    expect(await t.bot.pollOnce(0)).toBe(2);
    await t.bot.settle();
    expect(t.store.kvGet(KV_OFFSET)).toBe("9");
    expect(t.sent().some((s) => s.includes("Falha ao ler"))).toBe(true);
    expect(t.sent().some((s) => s.includes("Status · Perfil Teste"))).toBe(true);
  });

  it("start registers commands, polls with backoff on errors, stop ends", async () => {
    const t = setup();
    let n = 0;
    const bot = t.bot as any;
    const real = bot.d.api.getUpdates.bind(bot.d.api);
    bot.d.api.getUpdates = async (...a: unknown[]) => {
      if (++n === 1) throw new Error("net down");
      if (n === 3) void t.bot.stop();
      return real(...a);
    };
    await t.bot.start();
    const loop = bot.loop as Promise<void>;
    await loop;
    expect(n).toBeGreaterThanOrEqual(3);
    const cmds = t.net.of("setMyCommands")[0]!.body.commands as { command: string }[];
    expect(cmds.map((c) => c.command)).toEqual(BOT_COMMANDS.map((c) => c.name));
  });
});

describe("commands and aliases", () => {
  const cases: [string, string][] = [
    ["/ler", "Li 3 fontes"],
    ["/scan", "Li 3 fontes"],
    ["/status", "Status · Perfil Teste"],
    ["/pausar", "Pausado"],
    ["/pause", "Pausado"],
    ["/retomar", "Retomado"],
    ["/resume", "Retomado"],
    ["/ajuda", "Comandos"],
    ["/help", "Comandos"],
    ["/start", "Comandos"],
    ["/agenda", "09/11 às 13:15"],
    ["/schedule", "09/11 às 13:15"],
    ["/pendentes", "Aguardando aprovação (1)"],
    ["/pending", "Aguardando aprovação (1)"],
    ["/fila", "Fila (1)"],
    ["/queue", "Fila (1)"],
    ["/status@meu_bot", "Status"],
    ["/xyz", "Comando desconhecido"],
    ["qualquer coisa", "Não entendi"],
  ];
  it.each(cases)("%s", async (cmd, expected) => {
    const t = setup();
    t.store.add(item());
    await t.text(cmd);
    expect(t.sent().at(-1)).toContain(expected);
  });

  it("/furar and /desfurar (and aliases)", async () => {
    const t = setup();
    t.store.add(item());
    await t.text("/furar p_ab12");
    expect(t.store.get("p_ab12")!.priority).toBe(100);
    await t.text("/unbump p_ab12");
    expect(t.store.get("p_ab12")!.priority).toBe(0);
    await t.text("/bump p_ab12");
    expect(t.store.get("p_ab12")!.priority).toBe(100);
    await t.text("/furar");
    expect(t.sent().at(-1)).toContain("Uso: /furar <id>");
    await t.text("/furar nada");
    expect(t.sent().at(-1)).toContain("Não achei");
  });

  it("/pausar toggles actions", async () => {
    const t = setup();
    await t.text("/pausar");
    await t.text("/resume");
    expect(t.actions.log).toEqual(["paused:true", "paused:false"]);
  });

  it("/config lists settings; /definir changes one (usage, errors, success)", async () => {
    const t = setup();
    await t.text("/config");
    expect(t.sent().some((s) => s.includes("Configurações") && s.includes("/definir aprovacoes_dia"))).toBe(true);
    await t.text("/definir aprovacoes_dia");
    expect(t.sent().some((s) => s.includes("Uso: /definir"))).toBe(true);
    await t.text("/definir aprovacoes_dia bad");
    expect(t.sent().some((s) => s.includes("Erro: valor inválido"))).toBe(true);
    await t.text("/set aprovacoes_dia 5");
    expect(t.actions.log).toEqual(["set:aprovacoes_dia=bad", "set:aprovacoes_dia=5"]);
    expect(t.sent().some((s) => s.includes("reinício"))).toBe(true);
  });

  it("/add, bare URL triggers add, errors and usage", async () => {
    const t = setup();
    await t.text("/add https://x.com/a/status/1 comentário");
    expect(t.actions.log).toContain("add:https://x.com/a/status/1 comentário");
    expect(t.sent().at(-1)).toContain("Adicionado: p_new1");
    await t.text("https://example.com/artigo");
    expect(t.actions.log).toContain("add:https://example.com/artigo");
    await t.text("/add bad");
    expect(t.sent().at(-1)).toContain("link inválido");
    await t.text("/add");
    expect(t.sent().at(-1)).toContain("Uso: /add");
    expect(t.actions.log.filter((l) => l === "runPipeline")).toHaveLength(2);
  });

  it("/fila groups several statuses", async () => {
    const t = setup();
    t.store.add(item({ id: "a", status: "new" }));
    t.store.add(item({ id: "b", status: "approved" }));
    t.store.add(item({ id: "c", status: "published" }));
    await t.text("/fila");
    const s = t.sent().at(-1)!;
    expect(s).toContain("Novos (1)");
    expect(s).toContain("Aprovados (1)");
    expect(s).not.toContain("c ·");
  });
});

describe("sendApproval / notify", () => {
  it("sends media with captions then the card with keyboard, to every chat; tracks primary ids", async () => {
    const t = setup({ chats: ["1", "2"] });
    const i = t.store.add(item({ prepared: [{ type: "image", localPath: tmpFile("a.png"), thirdParty: false }, { type: "video", localPath: tmpFile("b.mp4"), thirdParty: false, width: 720, height: 1280 }] }));
    const ids = await t.bot.sendApproval(i);
    expect(ids).toHaveLength(3);
    expect(t.store.msgs.p_ab12).toEqual(ids);
    expect(t.net.of("sendPhoto").map((c) => c.form!.get("caption"))).toEqual(["p_ab12 · Título do post (1/2)", "p_ab12 · Título do post (1/2)"].slice(0, 2));
    expect(t.net.of("sendVideo")).toHaveLength(2);
    const cards = t.net.of("sendMessage");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.body.reply_markup.inline_keyboard[0][0].callback_data).toBe("a|p_ab12");
    await t.bot.notify("oi");
    expect(t.net.of("sendMessage")).toHaveLength(4);
  });

  it("a failing secondary chat does not break the primary", async () => {
    const t = setup({ chats: ["1", "2"] });
    const api = (t.bot as any).d.api;
    const real = api.sendMessage.bind(api);
    api.sendMessage = async (chat: string, ...r: unknown[]) => {
      if (chat === "2") throw new Error("blocked");
      return real(chat, ...r);
    };
    await expect(t.bot.notify("x")).resolves.toBeUndefined();
  });
});

describe("approve flow", () => {
  it("mixed buffer + manual + failed outcomes", async () => {
    const t = setup({ uiOver: { destinations: [{ platform: "instagram", publisher: "buffer", mode: "queue", dailyCap: 4, only: "any" }, { platform: "linkedin", publisher: "manual", mode: "draft", dailyCap: 4, only: "any", composeUrl: "https://www.linkedin.com/feed/" }, { platform: "tiktok", publisher: "buffer", mode: "draft", dailyCap: 4, only: "any" }] } });
    t.store.add(item({ telegramMsgIds: [10, 11], prepared: [{ type: "image", localPath: tmpFile("a.png"), thirdParty: false, platform: "linkedin" }, { type: "image", localPath: tmpFile("b.png"), thirdParty: false, platform: "instagram" }] }));
    t.actions.outcomes = [
      { platform: "instagram", kind: "buffer", mode: "queue", scheduledAt: "2026-11-09T16:15:00Z" },
      { platform: "linkedin", kind: "manual" },
      { platform: "tiktok", kind: "failed", error: "timeout" },
    ];
    await t.press("a|p_ab12");
    expect(t.actions.log).toEqual(["approve:p_ab12"]);
    expect(t.net.of("answerCallbackQuery")).toHaveLength(1);
    expect(t.net.of("deleteMessages")[0]!.body).toEqual({ chat_id: "1", message_ids: [10, 11] });
    const [outcome, final] = t.sent();
    expect(outcome).toContain("Instagram: agendado para 09/11 às 13:15");
    expect(outcome).toContain("TikTok: o Buffer falhou (timeout)");
    // only the linkedin-tagged media goes to manual (instagram's belongs to buffer)
    expect(t.net.of("sendPhoto")).toHaveLength(1);
    expect(t.net.of("sendPhoto")[0]!.form!.get("caption")).toBe("FINAL p_ab12 · Título do post (1/1)");
    expect(final).toContain("Postar manualmente no LinkedIn + TikTok");
    const kb = t.net.of("sendMessage")[1]!.body.reply_markup.inline_keyboard;
    expect(kb[0][0].url).toBe("https://www.linkedin.com/feed/");
    expect(kb.flat().map((b: any) => b.callback_data).filter(Boolean)).toEqual(["p|p_ab12|linkedin", "p|p_ab12|tiktok"]);
  });

  it("buffer-only approval leaves no message in the chat", async () => {
    const t = setup();
    t.store.add(item());
    await t.press("a|p_ab12");
    expect(t.sent()).toHaveLength(0);
  });

  it("guard: already decided item", async () => {
    const t = setup();
    t.store.add(item({ status: "approved" }));
    for (const a of ["a", "r", "eb", "eh", "rg"]) await t.press(`${a}|p_ab12`);
    expect(t.actions.log).toEqual([]);
    expect(t.net.of("answerCallbackQuery").map((c) => c.body.text)).toEqual(Array(5).fill("Já está em approved"));
  });

  it("p marks published", async () => {
    const t = setup();
    t.store.add(item({ status: "approved" }));
    await t.press("p|p_ab12|linkedin");
    expect(t.actions.log).toEqual(["published:p_ab12:linkedin"]);
    expect(t.sent().at(-1)).toContain("publicado no linkedin");
  });

  it("handler error is reported and does not throw", async () => {
    const t = setup();
    t.store.add(item());
    t.actions.approve = async () => {
      throw new Error("falhou");
    };
    await expect(t.press("a|p_ab12")).resolves.toBeUndefined();
    expect(t.sent().at(-1)).toContain("Erro: falhou");
  });
});

describe("reject flow", () => {
  it("r opens reasons keyboard, voltar restores, rj rejects", async () => {
    const t = setup();
    t.store.add(item({ telegramMsgIds: [5] }));
    await t.press("r|p_ab12", 1, 77);
    const kb = t.net.of("editMessageReplyMarkup")[0]!;
    expect(kb.body.message_id).toBe(77);
    expect(kb.body.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "rj|p_ab12|sem_valor")).toBe(true);
    await t.press("b|p_ab12", 1, 77);
    expect(t.net.of("editMessageReplyMarkup")[1]!.body.reply_markup.inline_keyboard[0][0].callback_data).toBe("a|p_ab12");
    await t.press("rj|p_ab12|sem_valor");
    expect(t.actions.log).toEqual(["reject:p_ab12:sem_valor"]);
    expect(t.net.of("deleteMessages")).toHaveLength(1);
    expect(t.sent()).toHaveLength(0); // rejected post leaves the chat, no confirmation
  });

  it("unknown reason code is refused", async () => {
    const t = setup();
    t.store.add(item());
    await t.press("rj|p_ab12|hack");
    expect(t.actions.log).toEqual([]);
  });
});

describe("edit, regenerate and cancel flows", () => {
  it("edit body: await state, then setDraft + recordApproval + reprepare", async () => {
    const t = setup();
    t.store.add(item());
    await t.press("eb|p_ab12");
    expect(t.store.kvGet(KV_AWAIT)).toBe("body:p_ab12");
    await t.text("Novo texto\ncom linhas");
    expect(t.store.get("p_ab12")!.draft!.body).toBe("Novo texto\ncom linhas");
    expect(t.store.get("p_ab12")!.draft!.headline).toBe("Título do post");
    expect(t.store.approvals).toEqual([{ id: "p_ab12", action: "edit_body", reason: undefined }]);
    expect(t.actions.log).toEqual(["reprepare:p_ab12"]);
    expect(t.store.kvGet(KV_AWAIT)).toBeUndefined();
  });

  it("edit headline clips to 200; body clips to 5000", async () => {
    const t = setup();
    t.store.add(item());
    await t.press("eh|p_ab12");
    expect(t.store.kvGet(KV_AWAIT)).toBe("head:p_ab12");
    await t.text("h".repeat(300));
    expect(t.store.get("p_ab12")!.draft!.headline).toHaveLength(200);
    expect(t.store.approvals[0]!.action).toBe("edit_headline");
    await t.press("eb|p_ab12");
    await t.text("b".repeat(6000));
    expect(t.store.get("p_ab12")!.draft!.body).toHaveLength(5000);
  });

  it("regenerate with instruction and with /igual", async () => {
    const t = setup();
    t.store.add(item());
    await t.press("rg|p_ab12");
    expect(t.store.kvGet(KV_AWAIT)).toBe("regen:p_ab12");
    await t.text("mais curto, sem emoji");
    expect(t.actions.log).toEqual(["regenerate:p_ab12:mais curto, sem emoji"]);
    await t.press("rg|p_ab12");
    await t.text("/igual");
    expect(t.actions.log.at(-1)).toBe("regenerate:p_ab12:");
    expect(t.store.kvGet(KV_AWAIT)).toBeUndefined();
  });

  it("/cancelar clears the state; any command cancels it too", async () => {
    const t = setup();
    t.store.add(item());
    await t.press("eb|p_ab12");
    await t.text("/cancelar");
    expect(t.store.kvGet(KV_AWAIT)).toBeUndefined();
    expect(t.sent().at(-1)).toContain("Cancelado");
    await t.text("depois do cancel");
    expect(t.store.get("p_ab12")!.draft!.body).toBe("Corpo do texto.");
    expect(t.sent().at(-1)).toContain("Não entendi");

    await t.press("eh|p_ab12");
    await t.text("/status");
    expect(t.store.kvGet(KV_AWAIT)).toBeUndefined();
    await t.text("texto solto");
    expect(t.store.get("p_ab12")!.draft!.headline).toBe("Título do post");

    await t.text("/cancel");
    expect(t.sent().at(-1)).toContain("Nada para cancelar");
  });

  it("reply after the item left pending_approval does not edit", async () => {
    const t = setup();
    t.store.add(item());
    await t.press("eb|p_ab12");
    t.store.get("p_ab12")!.status = "rejected";
    await t.text("novo");
    expect(t.store.approvals).toEqual([]);
    expect(t.sent().at(-1)).toContain("Já está em rejected");
  });
});

describe("review fixes", () => {
  it("TikTok manual flow shows only the tiktok variant, not the generic video too", async () => {
    const t = setup({ uiOver: { destinations: [{ platform: "tiktok", publisher: "manual", mode: "draft", dailyCap: 4, only: "video" }] } });
    t.store.add(item({ prepared: [{ type: "video", localPath: tmpFile("g.mp4"), thirdParty: false }, { type: "video", localPath: tmpFile("t.mp4"), thirdParty: false, platform: "tiktok" }] }));
    t.actions.outcomes = [{ platform: "tiktok", kind: "manual" }];
    await t.press("a|p_ab12");
    expect(t.net.of("sendVideo")).toHaveLength(1);
  });

  it("deletes the old approval cards after an edit re-sends the card, and after regenerate", async () => {
    const t = setup();
    t.store.add(item({ telegramMsgIds: [10, 11] }));
    t.actions.reprepare = async () => t.store.setTelegramMsgs("p_ab12", [20, 21]);
    await t.press("eb|p_ab12");
    await t.text("novo");
    expect(t.net.of("deleteMessages").map((c) => c.body.message_ids)).toEqual([[10, 11]]);
    t.actions.regenerate = async () => t.store.setTelegramMsgs("p_ab12", [30]);
    await t.press("rg|p_ab12");
    await t.text("/igual");
    expect(t.net.of("deleteMessages").map((c) => c.body.message_ids).at(-1)).toEqual([20, 21]);
  });

  it("does not delete the old cards when the action fails, and reports the error", async () => {
    const t = setup();
    t.store.add(item({ telegramMsgIds: [10] }));
    t.actions.reprepare = async () => { throw new Error("falhou"); };
    await t.press("eb|p_ab12");
    await t.text("novo");
    expect(t.net.of("deleteMessages")).toHaveLength(0);
    expect(t.sent().at(-1)).toContain("falhou");
  });

  it("long actions run detached: /ler, regenerate and reprepare do not block handleUpdate", async () => {
    const t = setup();
    t.store.add(item());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.actions.ingestNow = async () => (await gate, "pronto");
    t.actions.regenerate = async () => gate;
    t.actions.reprepare = async () => gate;
    await t.bot.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 1 }, text: "/ler" } });
    expect(t.sent().at(-1)).toContain("Lendo");
    const cb = (data: string) => t.bot.handleUpdate({ update_id: 2, callback_query: { id: "cq", data, message: { message_id: 50, chat: { id: 1 } } } });
    await cb("rg|p_ab12");
    await t.bot.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 1 }, text: "/igual" } });
    await cb("eb|p_ab12");
    await t.bot.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 1 }, text: "texto" } });
    expect(t.sent().at(-1)).toContain("Preparando");
    release();
    await t.bot.settle();
    expect(t.sent().some((s) => s === "pronto")).toBe(true);
  });

  it("start() throws on an invalid token (401/404) and does not start polling", async () => {
    for (const status of [401, 404]) {
      const t = setup();
      (t.bot as any).d.api.getMe = async () => { throw new TelegramError("Unauthorized", status); };
      await expect(t.bot.start()).rejects.toThrow(/Token do Telegram inválido/);
      expect((t.bot as any).loop).toBeUndefined();
    }
  });

  it("a 409 Conflict from getUpdates is fatal: the loop ends and `failed` resolves", async () => {
    const t = setup();
    (t.bot as any).d.api.getUpdates = async () => { throw new TelegramError("Conflict", 409); };
    await t.bot.start();
    const err = await t.bot.failed;
    expect(err.message).toMatch(/409/);
    await t.bot.stop();
  });

  it("sendApproval deletes the media already sent when the card fails, then rethrows", async () => {
    const t = setup();
    const i = t.store.add(item({ prepared: [{ type: "image", localPath: tmpFile("a.png"), thirdParty: false }] }));
    (t.bot as any).d.api.sendMessage = async () => { throw new Error("card falhou"); };
    await expect(t.bot.sendApproval(i)).rejects.toThrow("card falhou");
    expect(t.net.of("deleteMessages").map((c) => c.body.message_ids)).toEqual([[100]]);
  });

  it("allowedUserIds: the sender must be listed in addition to the chat", async () => {
    const t = setup({ users: ["42"] });
    const msg = (from?: number) => ({ update_id: 1, message: { message_id: 1, chat: { id: 1 }, from: from === undefined ? undefined : { id: from }, text: "/status" } });
    await t.bot.handleUpdate(msg(7));
    await t.bot.handleUpdate(msg());
    expect(t.net.calls).toHaveLength(0);
    await t.bot.handleUpdate(msg(42));
    expect(t.sent().at(-1)).toContain("Status");
  });
});
