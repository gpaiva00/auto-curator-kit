import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { silentLogger } from "@auto-curator/contracts";
import { BufferPublisher } from "@auto-curator/publishers";
import { FakeLlm, okDraft } from "@auto-curator/engine/testing";
import { buildRuntime } from "../src/wire.js";
import { cleanEnv, REPO_PROFILES, tmpDir } from "./helpers.js";

/** Perfil de exemplo com dois destinos Buffer (LinkedIn e Threads), sem mídia e com crédito oculto: o texto é o corpo. */
function profileDir(): string {
  const dir = join(tmpDir(), "perfil");
  cpSync(join(REPO_PROFILES, "astronomia"), dir, { recursive: true, filter: (src) => !/(^|\/)\.env$/.test(src) });
  const pj = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as Record<string, unknown>;
  pj.sources = [{ type: "manual" }];
  pj.destinations = [
    { platform: "linkedin", publisher: "buffer", mode: "draft", dailyCap: 4, only: "any" },
    { platform: "threads", publisher: "buffer", mode: "draft", dailyCap: 4, only: "any" },
  ];
  pj.media = { strategy: "none" };
  pj.editorial = { credit: "hide" };
  writeFileSync(join(dir, "profile.json"), JSON.stringify(pj));
  return dir;
}

/** Buffer falso na rede: grava cada chamada e responde createPost com um id. */
function fakeBufferNetwork() {
  const calls: { body: any }[] = [];
  let n = 0;
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ body });
    if (String(body.query).includes("createPost")) {
      n++;
      return new Response(JSON.stringify({ data: { createPost: { post: { id: `post-${n}` } } } }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: {} }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const posts = () => calls.filter((c) => String(c.body.query).includes("createPost")).map((c) => c.body.variables.input as { channelId: string; text: string; saveToDraft?: boolean; metadata?: unknown });
  return { f, posts };
}

/** API do Telegram falsa: grava o que o bot envia. */
function fakeTelegramNetwork() {
  const sent: { method: string; text: string }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    const body = typeof init?.body === "string" ? init.body : "";
    sent.push({ method, text: body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length, chat: { id: 7 }, date: 0, text: "" } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, sent, all: () => sent.map((s) => s.text).join("\n") };
}

/** Pipeline até o cartão no Telegram, depois o clique em "aprovar" no bot. */
async function aprovar(bodyLen: number) {
  const dir = profileDir();
  const body = "a".repeat(bodyLen);
  const bufferNet = fakeBufferNetwork();
  const tg = fakeTelegramNetwork();
  const buffer = new BufferPublisher({ apiKey: "chave-falsa", channels: { linkedin: "li1", threads: "th1" }, fetch: bufferNet.f });
  const llm = new FakeLlm({ curator: okDraft({ body, hashtags: [], sourceCredit: undefined }) });
  const env = cleanEnv(tmpDir(), { GROQ_API_KEY: "g", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOWED_CHAT_IDS: "7" });
  const rt = buildRuntime(dir, env, { withTelegram: true, logger: silentLogger, llm, telegramFetch: tg.f, plugins: { publishers: { buffer } } });
  await rt.app.addManual("texto manual para testar o limite do threads ponta a ponta");
  await rt.app.runPipeline();
  const [item] = rt.store.list(["pending_approval"]);
  if (!item) throw new Error("item deveria estar aguardando aprovação");
  tg.sent.length = 0; // só o que vem depois do clique
  await rt.bot!.handleUpdate({ update_id: 3, callback_query: { id: "cq", data: `a|${item.id}`, message: { message_id: 50, chat: { id: 7 } } } });
  return { rt, item, body, bufferNet, tg };
}

describe("ponta a ponta: limite de 500 caracteres do Threads (Store real, Buffer falso, Telegram falso)", () => {
  it("501 caracteres: LinkedIn recebe o rascunho completo; Threads vai para envio manual; Telegram entrega o texto para publicar à mão", async () => {
    const { rt, item, body, bufferNet, tg } = await aprovar(501);
    try {
      // LinkedIn: rascunho completo, no canal do LinkedIn
      const linkedin = bufferNet.posts().filter((p) => p.channelId === "li1");
      expect(linkedin).toHaveLength(1);
      expect(linkedin[0]!.text).toBe(body);
      expect(linkedin[0]!.saveToDraft).toBe(true);
      // Threads: nenhuma chamada ao Buffer; a regra do engine manda para envio manual antes
      expect(bufferNet.posts().filter((p) => p.channelId === "th1")).toHaveLength(0);

      // Telegram: sem falha, só o texto para publicar à mão no Threads (a nota fica no registro)
      const out = tg.all();
      expect(out).toMatch(/Postar manualmente no Threads/);
      expect(out).toContain(body);

      // Estado e registro por destino
      const rows = rt.store.publicationsOf(item.id);
      const li = rows.find((r) => r.platform === "linkedin");
      const th = rows.find((r) => r.platform === "threads");
      expect(li).toMatchObject({ publisher: "buffer", status: "scheduled", externalId: "post-1" });
      expect(th).toMatchObject({ publisher: "manual", status: "manual" });
      expect(th?.error).toMatch(/passa do limite de 500/);
      expect(rt.store.get(item.id)!.status).toBe("approved");
    } finally {
      rt.close();
    }
  });

  it("500 caracteres: passa direto nos dois destinos, sem falha nem texto manual", async () => {
    const { rt, item, body, bufferNet, tg } = await aprovar(500);
    try {
      const posts = bufferNet.posts();
      expect(posts).toHaveLength(2);
      expect(posts.map((p) => p.channelId).sort()).toEqual(["li1", "th1"]);
      expect(posts.every((p) => p.text === body && p.saveToDraft === true)).toBe(true);

      const out = tg.all();
      expect(out).not.toMatch(/500 caracteres/);
      expect(out).not.toMatch(/Postar manualmente/);
      // sucesso não gera relatório de falha: o bot só responde o clique

      const rows = rt.store.publicationsOf(item.id);
      expect(rows.map((r) => [r.platform, r.status])).toEqual(expect.arrayContaining([["linkedin", "scheduled"], ["threads", "scheduled"]]));
      expect(rt.store.get(item.id)!.status).toBe("published");
    } finally {
      rt.close();
    }
  });
});
