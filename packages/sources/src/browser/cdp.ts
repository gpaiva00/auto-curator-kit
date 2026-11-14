import type { SourceContext } from "@auto-curator/contracts";
import { RateLimiter, type LimiterOptions } from "./limiter.js";
import { BrowserError } from "./errors.js";

export { BrowserError, isStopError } from "./errors.js";
export { RateLimiter } from "./limiter.js";

export const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

/** The debug port gives full control of the browser: only loopback is accepted. */
export function resolveCdpUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.BROWSER_CDP_URL?.trim() || DEFAULT_CDP_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BrowserError(`BROWSER_CDP_URL inválida: "${raw}".`, "FAILED");
  }
  if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) {
    throw new BrowserError(`BROWSER_CDP_URL precisa apontar para esta máquina (127.0.0.1); recebi "${u.hostname}". A porta de depuração dá controle total do navegador.`, "FAILED");
  }
  return raw;
}

/** What a read does in a fresh background tab. */
export interface PageRequest {
  url: string;
  /** Plain JS expression evaluated in the page; its (JSON) value is returned. A string on purpose: see x-feed.ts. */
  script: string;
  /** Wait (up to readyTimeoutMs) for this selector before reading. */
  readySelector?: string;
  readyTimeoutMs?: number;
  /** Click a tab by accessible name (e.g. X "Following"). */
  clickTab?: RegExp;
  /** How many times to scroll down (human-like wheel moves). */
  scrolls?: number;
  scrollPx?: number;
  /** Min/max dwell before reading, in ms. */
  dwellMs?: [number, number];
}

/** The seam between sources and the browser. Tests inject a fake; production uses CdpPageReader. */
export interface PageReader {
  isAvailable(): Promise<boolean>;
  read<T>(req: PageRequest): Promise<T>;
}

/** The little a read needs from a tab (a Playwright Page adapts to it, tests fake it). */
export interface TabPage {
  goto(url: string, o: { timeoutMs: number }): Promise<void>;
  clickTab(name: RegExp, timeoutMs: number): Promise<void>;
  waitForSelector(selector: string, timeoutMs: number): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  wheel(dy: number): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  close(): Promise<void>;
}
export interface Connection {
  newTab(): Promise<TabPage>;
  close(): Promise<void>;
}

export interface CdpReaderOptions {
  cdpUrl: string;
  navTimeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Test seam: replaces playwright's connectOverCDP. */
  connect?: (cdpUrl: string) => Promise<Connection>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reads pages the way a person would: in a REAL Chrome (dedicated profile, logged in with a SECONDARY account) over the
 * DevTools protocol. Opens a background tab, waits, scrolls a little, evaluates a script. No private API, no cookies
 * handed to third parties. Still automated access to a third-party site: keep the volume low.
 */
export class CdpPageReader implements PageReader {
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rnd: () => number;

  constructor(private readonly o: CdpReaderOptions) {
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? defaultSleep;
    this.rnd = o.random ?? Math.random;
    resolveCdpUrl({ BROWSER_CDP_URL: o.cdpUrl });
  }

  async isAvailable(): Promise<boolean> {
    if (this.o.connect) return true;
    try {
      const r = await this.f(new URL("/json/version", this.o.cdpUrl), { signal: AbortSignal.timeout(2500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async read<T>(req: PageRequest): Promise<T> {
    if (!(await this.isAvailable())) {
      throw new BrowserError("O Chrome dedicado não está aberto. Rode scripts/chrome-reader.sh e entre com a conta secundária.", "NOT_AVAILABLE");
    }
    const conn = await (this.o.connect ?? connectPlaywright)(this.o.cdpUrl);
    try {
      const page = await conn.newTab();
      try {
        await page.goto(req.url, { timeoutMs: this.o.navTimeoutMs ?? 45_000 });
        if (req.clickTab) await page.clickTab(req.clickTab, 8000).catch(() => {});
        if (req.readySelector) await page.waitForSelector(req.readySelector, req.readyTimeoutMs ?? 15_000).catch(() => {});
        const [lo, hi] = req.dwellMs ?? [2500, 5500];
        await this.sleep(lo + this.rnd() * (hi - lo));
        await page.moveMouse(300 + this.rnd() * 400, 300 + this.rnd() * 300);
        for (let i = 0; i < (req.scrolls ?? 0); i++) {
          await page.wheel((req.scrollPx ?? 700) + this.rnd() * 400);
          await this.sleep(1200 + this.rnd() * 1500);
        }
        return (await page.evaluate(req.script)) as T;
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await conn.close().catch(() => {}); // for connectOverCDP this only disconnects; Chrome stays open
    }
  }
}

/** Default connection: playwright-core over CDP, opening tabs in the background so the dedicated window never jumps to front. */
async function connectPlaywright(cdpUrl: string): Promise<Connection> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(cdpUrl);
  return {
    async newTab() {
      const ctx = browser.contexts()[0];
      if (!ctx) throw new BrowserError("O Chrome dedicado está sem contexto de navegação.", "FAILED");
      const cdp = await browser.newBrowserCDPSession();
      let page;
      try {
        [page] = await Promise.all([ctx.waitForEvent("page", { timeout: 15_000 }), cdp.send("Target.createTarget", { url: "about:blank", background: true })]);
      } finally {
        await cdp.detach().catch(() => {});
      }
      const p = page;
      return {
        goto: async (url, o) => void (await p.goto(url, { waitUntil: "domcontentloaded", timeout: o.timeoutMs })),
        clickTab: async (name, timeoutMs) => void (await p.getByRole("tab", { name }).first().click({ timeout: timeoutMs })),
        waitForSelector: async (sel, timeoutMs) => void (await p.waitForSelector(sel, { timeout: timeoutMs })),
        moveMouse: async (x, y) => void (await p.mouse.move(x, y, { steps: 8 })),
        wheel: async (dy) => void (await p.mouse.wheel(0, dy)),
        evaluate: (script) => p.evaluate(script),
        close: () => p.close(),
      };
    },
    close: () => browser.close(),
  };
}

export interface BrowserLimits {
  minDelaySeconds: number;
  maxPerHour: number;
  cooldownMinutes: number;
}

/** A page reader behind the persistent limiter: this is what x-feed and instagram-profile talk to. */
export class BrowserSession {
  constructor(readonly reader: PageReader, readonly limiter: RateLimiter) {}

  isAvailable(): Promise<boolean> {
    return this.reader.isAvailable();
  }

  /** One rate-limited read. A block page (login/challenge) must be reported by the caller with `limiter.trip()`. */
  read<T>(req: PageRequest): Promise<T> {
    return this.limiter.schedule(() => this.reader.read<T>(req));
  }
}

export interface OpenBrowserOptions {
  limits: BrowserLimits & { jitterSeconds?: number };
  /** Key prefix of the limiter state inside SourceContext.state. */
  stateKey?: string;
  reader?: PageReader;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  limiterOverrides?: Partial<LimiterOptions>;
}

/** Shared entry point: connects to the dedicated Chrome (BROWSER_CDP_URL, default http://127.0.0.1:9222) with limits persisted in `ctx.state`. */
export function openBrowser(ctx: Pick<SourceContext, "env" | "state">, o: OpenBrowserOptions): BrowserSession {
  const reader = o.reader ?? new CdpPageReader({ cdpUrl: resolveCdpUrl(ctx.env), fetch: o.fetch, sleep: o.sleep });
  const limiter = new RateLimiter({ ...o.limits, store: ctx.state, key: o.stateKey ?? "browser.limiter", sleep: o.sleep, ...o.limiterOverrides });
  return new BrowserSession(reader, limiter);
}
