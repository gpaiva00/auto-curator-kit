import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The repo's scripts/chrome-reader.sh (this file lives in packages/sources/src/browser). */
export const DEFAULT_READER_SCRIPT = fileURLToPath(new URL("../../../../scripts/chrome-reader.sh", import.meta.url));

export interface LaunchOptions {
  cdpUrl: string;
  /** Profile name passed to chrome-reader.sh (its default is "default"). */
  name?: string;
  /** Path to chrome-reader.sh. Defaults to DEFAULT_READER_SCRIPT. */
  script?: string;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function cdpUp(cdpUrl: string): Promise<boolean> {
  try {
    const r = await fetch(new URL("/json/version", cdpUrl), { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Minimizes every window of the debug Chrome on cdpUrl (only that instance: other Chromes are not touched).
 * Returns how many windows it found; 0 means the first page has not appeared yet.
 */
async function minimizeWindows(cdpUrl: string): Promise<number> {
  const info = (await (await fetch(new URL("/json/version", cdpUrl), { signal: AbortSignal.timeout(2000) })).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  let seq = 0;
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as { id?: number; result?: any; error?: { message: string } };
    const p = m.id !== undefined ? pending.get(m.id) : undefined;
    if (!p) return;
    pending.delete(m.id!);
    if (m.error) p.fail(new Error(m.error.message));
    else p.ok(m.result);
  };
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok();
    ws.onerror = () => fail(new Error("DevTools websocket failed"));
  });
  const send = (method: string, params: object = {}) =>
    new Promise<any>((ok, fail) => {
      const id = ++seq;
      pending.set(id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    const { targetInfos } = await send("Target.getTargets");
    const windows = new Set<number>();
    for (const t of targetInfos as { type: string; targetId: string }[]) {
      if (t.type !== "page") continue;
      const { windowId } = await send("Browser.getWindowForTarget", { targetId: t.targetId });
      if (windows.has(windowId)) continue;
      windows.add(windowId);
      await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    }
    return windows.size;
  } finally {
    ws.close(); // only the DevTools connection; Chrome stays open
  }
}

/**
 * Opens the dedicated Chrome when its debug port is down, in the background (open -g: no focus stolen), then
 * minimizes its window through the DevTools protocol. Never throws: if it cannot start, the reader reports NOT_AVAILABLE.
 */
export async function launchDedicatedChrome(o: LaunchOptions): Promise<void> {
  const port = new URL(o.cdpUrl).port || "9222";
  const script = o.script ?? DEFAULT_READER_SCRIPT;
  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  await new Promise<void>((done) => {
    execFile(
      "bash",
      [script, o.name ?? "default", "window"],
      { env: { ...process.env, BROWSER_CDP_URL: o.cdpUrl, CHROME_READER_PORT: port }, timeout: 30_000 },
      () => done(),
    );
  });
  while (Date.now() < deadline && !(await cdpUp(o.cdpUrl))) await sleep(500);
  while (Date.now() < deadline) {
    try {
      if ((await minimizeWindows(o.cdpUrl)) > 0) return;
    } catch {
      // port answers but DevTools is not ready yet: retry
    }
    await sleep(500);
  }
}
