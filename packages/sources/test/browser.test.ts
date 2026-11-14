import { describe, expect, it } from "vitest";
import { CdpPageReader, RateLimiter, resolveCdpUrl, type TabPage } from "../src/browser/cdp.js";

describe("resolveCdpUrl", () => {
  it("defaults to 127.0.0.1:9222 and refuses non-loopback hosts", () => {
    expect(resolveCdpUrl({})).toBe("http://127.0.0.1:9222");
    expect(resolveCdpUrl({ BROWSER_CDP_URL: "http://localhost:9333" })).toBe("http://localhost:9333");
    expect(() => resolveCdpUrl({ BROWSER_CDP_URL: "http://example.com:9222" })).toThrow(/127\.0\.0\.1/);
    expect(() => resolveCdpUrl({ BROWSER_CDP_URL: "lixo" })).toThrow(/inválida/);
  });
});

describe("RateLimiter", () => {
  const mk = (o: Partial<ConstructorParameters<typeof RateLimiter>[0]> & { t: { now: number } }) => {
    const sleeps: number[] = [];
    const store = new Map<string, string>();
    const lim = () => new RateLimiter({ minDelaySeconds: 10, maxPerHour: 3, cooldownMinutes: 30, store: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) }, now: () => o.t.now, sleep: async (ms) => void (sleeps.push(ms), (o.t.now += ms)), random: () => 0, ...o });
    return { lim, sleeps, store };
  };

  it("waits the minimum gap after the previous read, even across instances (persisted state)", async () => {
    const t = { now: 1_000_000 };
    const { lim, sleeps } = mk({ t });
    await lim().schedule(async () => (t.now += 2000));
    await lim().schedule(async () => 1); // new instance, same store
    expect(sleeps).toEqual([10_000]);
  });

  it("caps reads per rolling hour and recovers after it", async () => {
    const t = { now: 0 };
    const { lim } = mk({ t, minDelaySeconds: 0 });
    for (let i = 0; i < 3; i++) await lim().schedule(async () => i);
    await expect(lim().schedule(async () => 0)).rejects.toMatchObject({ kind: "RATE_LIMITED" });
    t.now += 3_600_001;
    await expect(lim().schedule(async () => "ok")).resolves.toBe("ok");
  });

  it("trip() opens a cooldown that outlives the instance, then clears", async () => {
    const t = { now: 0 };
    const { lim } = mk({ t, minDelaySeconds: 0 });
    lim().trip();
    await expect(lim().schedule(async () => 1)).rejects.toThrow(/30 min/);
    t.now += 30 * 60_000 + 1;
    await expect(lim().schedule(async () => 1)).resolves.toBe(1);
  });

  it("serialises concurrent calls", async () => {
    const t = { now: 0 };
    const { lim } = mk({ t, minDelaySeconds: 0, maxPerHour: 10 });
    const l = lim();
    const order: string[] = [];
    await Promise.all([
      l.schedule(async () => { order.push("a1"); await Promise.resolve(); order.push("a2"); }),
      l.schedule(async () => { order.push("b1"); }),
    ]);
    expect(order).toEqual(["a1", "a2", "b1"]);
  });
});

describe("CdpPageReader", () => {
  const fakeTab = () => {
    const log: string[] = [];
    const tab: TabPage = {
      goto: async (u) => void log.push(`goto ${u}`),
      clickTab: async () => void log.push("clickTab"),
      waitForSelector: async (s) => void log.push(`wait ${s}`),
      moveMouse: async () => void log.push("mouse"),
      wheel: async () => void log.push("wheel"),
      evaluate: async (s) => (log.push("evaluate"), { script: s }),
      close: async () => void log.push("closeTab"),
    };
    return { log, connect: async () => ({ newTab: async () => tab, close: async () => void log.push("disconnect") }) };
  };

  it("opens a tab, navigates, clicks, waits, scrolls, evaluates and always cleans up", async () => {
    const { log, connect } = fakeTab();
    const r = new CdpPageReader({ cdpUrl: "http://127.0.0.1:9222", connect, sleep: async () => {}, random: () => 0 });
    const out = await r.read<{ script: string }>({ url: "https://x.com/home", script: "1+1", readySelector: "article", clickTab: /a/, scrolls: 2 });
    expect(out).toEqual({ script: "1+1" });
    expect(log).toEqual(["goto https://x.com/home", "clickTab", "wait article", "mouse", "wheel", "wheel", "evaluate", "closeTab", "disconnect"]);
  });

  it("reports NOT_AVAILABLE when the debug port does not answer", async () => {
    const r = new CdpPageReader({ cdpUrl: "http://127.0.0.1:9222", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    await expect(r.read({ url: "https://x.com", script: "1" })).rejects.toMatchObject({ kind: "NOT_AVAILABLE" });
  });

  it("rejects a non-loopback debugger URL", () => {
    expect(() => new CdpPageReader({ cdpUrl: "http://example.com:9222" })).toThrow();
  });
});
