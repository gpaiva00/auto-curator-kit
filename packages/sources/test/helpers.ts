import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { silentLogger, type ProfileConfig, type SourceContext } from "@auto-curator/contracts";
import type { PageReader, PageRequest } from "../src/browser/cdp.js";

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string): string => readFileSync(join(here, "fixtures", name), "utf8");

export const NOW = new Date("2026-11-14T12:00:00Z");

export function makeCtx(over: Partial<SourceContext> = {}): SourceContext & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    now: NOW,
    profile: { id: "teste", name: "Teste" } as unknown as ProfileConfig,
    dataDir: "/tmp/auto-curator-test",
    env: {},
    logger: silentLogger,
    state: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    ...over,
    store,
  };
}

type Route = string | { body: string; status?: number; type?: string; url?: string };

/** A fetch that serves canned bodies by exact URL (404 otherwise) and records every call. */
export function fakeFetch(routes: Record<string, Route>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const r = routes[url];
    if (r === undefined) return new Response("not found", { status: 404 });
    const o = typeof r === "string" ? { body: r } : r;
    const res = new Response(o.body, { status: o.status ?? 200, headers: { "content-type": o.type ?? "text/html; charset=utf-8" } });
    if (o.url) Object.defineProperty(res, "url", { value: o.url });
    return res;
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

/** A PageReader that answers by URL with a snapshot (or a function of the request). */
export function fakeReader(answer: (req: PageRequest) => unknown, available = true): PageReader & { requests: PageRequest[] } {
  const requests: PageRequest[] = [];
  return {
    requests,
    isAvailable: async () => available,
    read: async <T>(req: PageRequest) => {
      requests.push(req);
      return answer(req) as T;
    },
  };
}

export const noSleep = async () => {};
