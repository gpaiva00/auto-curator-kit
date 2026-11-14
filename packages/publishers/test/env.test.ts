import { describe, expect, it } from "vitest";
import { BufferPublisher, channelsFromEnv, createBufferFromEnv } from "../src/index.js";
import { bufferRoute, dest, fakeFetch, req } from "./fake-fetch.js";

describe("channelsFromEnv", () => {
  it("reads BUFFER_CHANNEL_<PLATFORM> and honours a destination channelEnv override", () => {
    const env = { BUFFER_CHANNEL_INSTAGRAM: " ig1 ", BUFFER_CHANNEL_TIKTOK: "", BUFFER_CHANNEL_LINKEDIN: "li1", CUSTOM_TT: "tt9" };
    expect(channelsFromEnv(env, ["instagram", "tiktok", { platform: "tiktok", channelEnv: "CUSTOM_TT" }, "x"])).toEqual({
      instagram: "ig1",
      tiktok: "tt9",
    });
  });
});

describe("createBufferFromEnv", () => {
  it("returns undefined when BUFFER_API_KEY is empty", () => {
    expect(createBufferFromEnv({ BUFFER_API_KEY: "  " }, [dest()])).toBeUndefined();
    expect(createBufferFromEnv({}, [dest()])).toBeUndefined();
  });

  it("builds a publisher whose channels come from env and that only considers buffer destinations", async () => {
    const env = { BUFFER_API_KEY: "K", BUFFER_CHANNEL_INSTAGRAM: "ig-env", BUFFER_CHANNEL_LINKEDIN: "li-env" };
    const { fetch, calls } = fakeFetch(bufferRoute({}));
    const pub = createBufferFromEnv(env, [dest({ platform: "instagram" }), dest({ platform: "linkedin", publisher: "manual" })], undefined, { fetch });
    expect(pub).toBeInstanceOf(BufferPublisher);
    await pub!.publish(req());
    expect(calls.at(-1)!.body.variables.input.channelId).toBe("ig-env");
    expect(calls.at(-1)!.headers.authorization).toBe("Bearer K");
    expect(calls.some((c) => c.body.query.includes("account"))).toBe(false);
  });
});
