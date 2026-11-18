import { PublishError, type MediaHost } from "@auto-curator/contracts";
import { describe, expect, it } from "vitest";
import { BufferPublisher } from "../src/buffer.js";
import { bufferRoute, clip, dest, fakeFetch, photo, req } from "./fake-fetch.js";

const createPosts = (calls: { body: any }[]) => calls.filter((c) => String(c.body?.query).includes("createPost"));

describe("L1 — Threads como destino de canal (BufferPublisher)", () => {
  it("rascunho para o Threads: addToQueue + saveToDraft, sem metadata do LinkedIn", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const pub = new BufferPublisher({ apiKey: "K", channels: { threads: "th1" }, fetch });
    const r = await pub.publish(req({ destination: dest({ platform: "threads", mode: "draft" }), text: "post curto", firstComment: "comentário do LinkedIn" }));
    expect(r).toEqual({ externalId: "p1", mode: "draft" });
    const input = createPosts(calls).at(-1)!.body.variables.input;
    expect(input).toMatchObject({ channelId: "th1", text: "post curto", mode: "addToQueue", saveToDraft: true });
    expect(input.metadata).toBeUndefined();
  });

  it("aceita exatamente 500 caracteres", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const pub = new BufferPublisher({ apiKey: "K", channels: { threads: "th1" }, fetch });
    await pub.publish(req({ destination: dest({ platform: "threads" }), text: "a".repeat(500) }));
    expect(createPosts(calls)).toHaveLength(1);
  });

  it("recusa mais de 500 caracteres sem chamar createPost, com mensagem em português", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const pub = new BufferPublisher({ apiKey: "K", channels: { threads: "th1" }, fetch });
    const err = await pub.publish(req({ destination: dest({ platform: "threads" }), text: "a".repeat(501) })).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.message).toMatch(/Threads aceita até 500 caracteres \(o post tem 501\)/);
    expect(createPosts(calls)).toHaveLength(0);
  });

  it("o limite só vale para o Threads: o LinkedIn aceita o mesmo texto longo", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const pub = new BufferPublisher({ apiKey: "K", channels: { linkedin: "li1" }, fetch });
    await pub.publish(req({ destination: dest({ platform: "linkedin" }), text: "a".repeat(900) }));
    expect(createPosts(calls)).toHaveLength(1);
  });
});

describe("L2 — vídeo vai como asset para o LinkedIn", () => {
  it("sobe o vídeo pelo host e envia como asset de vídeo", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const uploads: string[] = [];
    const host: MediaHost = {
      name: "fake",
      supports: () => true,
      upload: async (p) => (uploads.push(p), `https://cdn.test/${p.split("/").pop()}`),
    };
    const pub = new BufferPublisher({ apiKey: "K", channels: { linkedin: "li1" }, fetch, mediaHost: host });
    const r = await pub.publish(req({ destination: dest({ platform: "linkedin" }), media: [clip("v.mp4")] }));
    expect(r.droppedMedia).toBeUndefined();
    expect(uploads).toEqual(["/tmp/v.mp4"]);
    const input = createPosts(calls).at(-1)!.body.variables.input;
    expect(input.assets).toEqual([{ video: { url: "https://cdn.test/v.mp4" } }]);
  });

  it("sem host que aceite vídeo, o vídeo é descartado e o post segue sem ele", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const imageOnly: MediaHost = { name: "img", supports: (k) => k === "image", upload: async () => "https://cdn.test/x.jpg" };
    const pub = new BufferPublisher({ apiKey: "K", channels: { linkedin: "li1" }, fetch, mediaHost: imageOnly });
    const r = await pub.publish(req({ destination: dest({ platform: "linkedin" }), media: [clip("v.mp4"), photo("a.jpg")] }));
    expect(r.droppedMedia).toBe(1);
    const input = createPosts(calls).at(-1)!.body.variables.input;
    expect(input.assets).toEqual([{ image: { url: "https://cdn.test/x.jpg" } }]);
  });
});
