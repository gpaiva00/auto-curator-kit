import { PublishError } from "@auto-curator/contracts";
import { describe, expect, it } from "vitest";
import { BufferPublisher } from "../src/buffer.js";
import { bufferRoute, clip, dest, fakeFetch, imageHost, json, photo, req } from "./fake-fetch.js";

const twoChannels = { o1: [{ id: "tw1", service: "twitter" }, { id: "li1", service: "linkedin" }] };

describe("BufferPublisher: modes", () => {
  it("draft: addToQueue + saveToDraft, returns the post id and the mode", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const pub = new BufferPublisher({ apiKey: "K", channels: { instagram: "ig1" }, fetch });
    const r = await pub.publish(req({ destination: dest({ mode: "draft" }) }));
    expect(r).toEqual({ externalId: "p1", mode: "draft" });
    const post = calls.at(-1)!;
    expect(post.headers.authorization).toBe("Bearer K");
    expect(post.body.variables.input).toMatchObject({
      channelId: "ig1",
      text: "texto do post",
      schedulingType: "automatic",
      mode: "addToQueue",
      saveToDraft: true,
      needsApproval: false,
      assets: [],
    });
  });

  it("queue: addToQueue without saveToDraft", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const pub = new BufferPublisher({ apiKey: "K", channels: { instagram: "ig1" }, fetch });
    expect(await pub.publish(req({ destination: dest({ mode: "queue" }) }))).toEqual({ externalId: "p1", mode: "queue" });
    expect(calls.at(-1)!.body.variables.input.mode).toBe("addToQueue");
    expect(calls.at(-1)!.body.variables.input).not.toHaveProperty("saveToDraft");
  });

  it("now: shareNow", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const pub = new BufferPublisher({ apiKey: "K", channels: { instagram: "ig1" }, fetch });
    expect(await pub.publish(req({ destination: dest({ mode: "now" }) }))).toEqual({ externalId: "p1", mode: "now" });
    expect(calls.at(-1)!.body.variables.input).toMatchObject({ mode: "shareNow" });
    expect(calls.at(-1)!.body.variables.input).not.toHaveProperty("saveToDraft");
  });

  it("sends the first comment only to LinkedIn, as metadata.linkedin.firstComment", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const pub = new BufferPublisher({ apiKey: "K", channels: { linkedin: "li1", instagram: "ig1" }, fetch });
    await pub.publish(req({ destination: dest({ platform: "linkedin" }), firstComment: "link aqui" }));
    expect(calls.at(-1)!.body.variables.input).toMatchObject({ channelId: "li1", metadata: { linkedin: { firstComment: "link aqui" } } });
    await pub.publish(req({ firstComment: "ignorado" }));
    expect(calls.at(-1)!.body.variables.input).toMatchObject({ metadata: { instagram: { type: "post", shouldShareToFeed: true } } });
    expect(JSON.stringify(calls.at(-1)!.body)).not.toContain("ignorado");
  });
});

describe("BufferPublisher: channel discovery", () => {
  it("uses the configured channel without querying the account", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({ channels: twoChannels }));
    await new BufferPublisher({ apiKey: "K", channels: { linkedin: "cfg" }, fetch }).publish(req({ destination: dest({ platform: "linkedin" }) }));
    expect(calls.map((c) => c.body.query).some((q: string) => q.includes("account"))).toBe(false);
    expect(calls.at(-1)!.body.variables.input.channelId).toBe("cfg");
  });

  it("discovers the single channel of the platform (service matches, aliases x -> twitter) and caches it", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({ channels: twoChannels }));
    const pub = new BufferPublisher({ apiKey: "K", channels: {}, fetch });
    await pub.publish(req({ destination: dest({ platform: "linkedin" }) }));
    expect(calls.at(-1)!.body.variables.input.channelId).toBe("li1");
    await pub.publish(req({ destination: dest({ platform: "linkedin" }) }));
    const accountQueries = calls.filter((c) => c.body.query.includes("account {")).length;
    expect(accountQueries).toBe(1);

    const x = fakeFetch(bufferRoute({ channels: twoChannels }));
    await new BufferPublisher({ apiKey: "K", channels: {}, fetch: x.fetch }).publish(req({ destination: dest({ platform: "x" }) }));
    expect(x.calls.at(-1)!.body.variables.input.channelId).toBe("tw1");
  });

  it("ignores disconnected channels and searches every organization", async () => {
    const { fetch, calls } = fakeFetch(
      bufferRoute({
        orgs: [{ id: "o1" }, { id: "o2" }],
        channels: { o1: [{ id: "old", service: "linkedin", isDisconnected: true }], o2: [{ id: "li2", service: "linkedin" }] },
      }),
    );
    await new BufferPublisher({ apiKey: "K", channels: {}, fetch }).publish(req({ destination: dest({ platform: "linkedin" }) }));
    expect(calls.at(-1)!.body.variables.input.channelId).toBe("li2");
  });

  it("no channel of the platform -> fatal PublishError in pt-BR", async () => {
    const { fetch } = fakeFetch(bufferRoute({ channels: { o1: [{ id: "tw1", service: "twitter" }] } }));
    const err = await new BufferPublisher({ apiKey: "K", channels: {}, fetch }).publish(req({ destination: dest({ platform: "linkedin" }) })).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.opts.fatal).toBe(true);
    expect(err.message).toContain("nenhum canal de linkedin conectado");
    expect(err.message).toContain("BUFFER_CHANNEL_LINKEDIN");
  });

  it("several channels of the platform -> fatal PublishError asking for the env var", async () => {
    const { fetch } = fakeFetch(bufferRoute({ channels: { o1: [{ id: "a", service: "linkedin" }, { id: "b", service: "linkedin" }] } }));
    const err = await new BufferPublisher({ apiKey: "K", channels: {}, fetch }).publish(req({ destination: dest({ platform: "linkedin" }) })).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.opts.fatal).toBe(true);
    expect(err.message).toContain("2 canais de linkedin");
  });
});

describe("BufferPublisher: media", () => {
  it("uploads each image through the host and attaches the URLs", async () => {
    const host = imageHost();
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const pub = new BufferPublisher({ apiKey: "K", channels: { instagram: "ig1" }, fetch, mediaHost: host });
    const r = await pub.publish(req({ media: [photo("a.jpg"), photo("b.png")] }));
    expect(host.uploads).toEqual(["/tmp/a.jpg", "/tmp/b.png"]);
    expect(calls.at(-1)!.body.variables.input.assets).toEqual([{ image: { url: "https://cdn.test/a.jpg" } }, { image: { url: "https://cdn.test/b.png" } }]);
    expect(r).not.toHaveProperty("droppedMedia");
  });

  it("instagram video becomes a reel asset", async () => {
    const host: ReturnType<typeof imageHost> = { ...imageHost(), supports: () => true };
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    await new BufferPublisher({ apiKey: "K", channels: { instagram: "ig1" }, fetch, mediaHost: host }).publish(req({ media: [clip("v.mp4")] }));
    expect(calls.at(-1)!.body.variables.input).toMatchObject({ assets: [{ video: { url: "https://cdn.test/v.mp4" } }], metadata: { instagram: { type: "reel" } } });
  });

  it("tiktok takes a video and sends tiktok metadata", async () => {
    const host: ReturnType<typeof imageHost> = { ...imageHost(), supports: () => true };
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    await new BufferPublisher({ apiKey: "K", channels: { tiktok: "tt1" }, fetch, mediaHost: host }).publish(req({ destination: dest({ platform: "tiktok" }), media: [clip()] }));
    expect(calls.at(-1)!.body.variables.input).toMatchObject({ channelId: "tt1", metadata: { tiktok: { isAiGenerated: false } } });
  });

  it("tiktok without a video is refused before any call to Buffer", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const pub = new BufferPublisher({ apiKey: "K", channels: { tiktok: "tt1" }, fetch });
    const err = await pub.publish(req({ destination: dest({ platform: "tiktok" }), media: [photo()] })).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.opts.fatal).toBeUndefined();
    expect(err.message).toContain("TikTok exige um vídeo");
    expect(calls).toHaveLength(0);
  });

  it("without a media host the post goes text only and reports droppedMedia", async () => {
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const r = await new BufferPublisher({ apiKey: "K", channels: { instagram: "ig1" }, fetch }).publish(req({ media: [photo(), photo("b.jpg")] }));
    expect(r).toEqual({ externalId: "p1", mode: "draft", droppedMedia: 2 });
    expect(calls.at(-1)!.body.variables.input.assets).toEqual([]);
  });

  it("media the host cannot take is dropped and counted; req.media is trusted as already selected", async () => {
    const host = imageHost(); // images only
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const pub = new BufferPublisher({ apiKey: "K", channels: { instagram: "ig1" }, fetch, mediaHost: host });
    const r = await pub.publish(req({ media: [photo("a.jpg"), clip("v.mp4")] }));
    expect(r.droppedMedia).toBe(1);
    expect(calls.at(-1)!.body.variables.input.assets).toEqual([{ image: { url: "https://cdn.test/a.jpg" } }]);
  });

  it("an upload failure is a retryable PublishError, not a silent text-only post", async () => {
    const host = { ...imageHost(), upload: async () => { throw new Error("rede caiu"); } };
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const err = await new BufferPublisher({ apiKey: "K", channels: { instagram: "ig1" }, fetch, mediaHost: host }).publish(req({ media: [photo()] })).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.message).toContain("rede caiu");
    expect(calls.some((c) => c.body.query?.includes("createPost"))).toBe(false);
  });
});

describe("BufferPublisher: errors", () => {
  const pubWith = (fetch: typeof globalThis.fetch) => new BufferPublisher({ apiKey: "K", channels: { instagram: "ig1" }, fetch });

  it.each([401, 403])("HTTP %i is fatal (auth)", async (status) => {
    const { fetch } = fakeFetch(() => json({}, status));
    const err = await pubWith(fetch).publish(req()).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.opts.fatal).toBe(true);
    expect(err.message).toContain("BUFFER_API_KEY");
  });

  it("HTTP 429 is fatal with retryAfterSec from the header", async () => {
    const { fetch } = fakeFetch(() => json({}, 429, { "retry-after": "60" }));
    await expect(pubWith(fetch).publish(req())).rejects.toMatchObject({ opts: { fatal: true, retryAfterSec: 60 } });
  });

  it("HTTP 429 without the header defaults to 900 seconds", async () => {
    const { fetch } = fakeFetch(() => json({}, 429));
    await expect(pubWith(fetch).publish(req())).rejects.toMatchObject({ opts: { fatal: true, retryAfterSec: 900 } });
  });

  it("other HTTP errors are plain (retryable) PublishErrors", async () => {
    const { fetch } = fakeFetch(() => json({}, 500));
    const err = await pubWith(fetch).publish(req()).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.opts.fatal).toBeUndefined();
    expect(err.message).toContain("HTTP 500");
  });

  it("a MutationError surfaces its message", async () => {
    const { fetch } = fakeFetch(bufferRoute({ createPost: () => ({ message: "Failed to fetch image" }) }));
    await expect(pubWith(fetch).publish(req())).rejects.toThrow("Failed to fetch image");
  });

  it("GraphQL errors surface their messages", async () => {
    const { fetch } = fakeFetch(() => json({ errors: [{ message: "Channel not found" }] }));
    await expect(pubWith(fetch).publish(req())).rejects.toThrow("Channel not found");
  });

  it("network failure becomes a PublishError", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(pubWith(fetch).publish(req())).rejects.toThrow(/falha de rede/);
  });
});

describe("BufferPublisher: interface", () => {
  it("has no listScheduled (the existing clients do not read the queue)", () => {
    expect(new BufferPublisher({ apiKey: "K", channels: {} })).not.toHaveProperty("listScheduled");
    expect(new BufferPublisher({ apiKey: "K", channels: {} }).name).toBe("buffer");
  });
});
