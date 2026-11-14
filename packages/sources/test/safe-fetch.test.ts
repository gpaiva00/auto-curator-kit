import { describe, expect, it } from "vitest";
import { readHtml } from "../src/page.js";
import { isPrivateIp, safeGet } from "../src/safe-fetch.js";

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
const html = (b = "<html><title>x</title></html>") => new Response(b, { headers: { "content-type": "text/html" } });
const pub = async () => ["93.184.216.34"];

function routed(routes: Record<string, () => Response>) {
  const calls: { url: string; redirect?: string }[] = [];
  const f = (async (u: string, init?: RequestInit) => {
    calls.push({ url: u, redirect: init?.redirect });
    const r = routes[u];
    return r ? r() : new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("isPrivateIp", () => {
  it("flags private, loopback, link-local and mapped addresses; passes public ones", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateIp(ip), ip).toBe(false);
  });
});

describe("safeGet / readHtml", () => {
  const opts = { timeoutMs: 1000, maxBytes: 1000, lookup: pub };

  it("refuses a hostname that resolves to a private address", async () => {
    const { f, calls } = routed({ "https://evil.example.com/": () => html() });
    expect(await safeGet("https://evil.example.com/", f, { ...opts, lookup: async () => ["10.0.0.5"] })).toBeUndefined();
    expect(await readHtml("https://evil.example.com/", f, { timeoutMs: 1000 })).toBeDefined(); // injected fake fetch: no DNS
    expect(calls).toHaveLength(1);
  });

  it("follows redirects manually and refuses a hop to a private host", async () => {
    const { f, calls } = routed({
      "https://a.example.com/": () => redirect("https://b.example.com/x"),
      "https://b.example.com/x": () => redirect("https://169.254.169.254/latest"),
    });
    expect(await safeGet("https://a.example.com/", f, opts)).toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual(["https://a.example.com/", "https://b.example.com/x"]);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("re-resolves DNS on each hop", async () => {
    const { f } = routed({ "https://a.example.com/": () => redirect("https://internal.example.com/"), "https://internal.example.com/": () => html() });
    const lookup = async (h: string) => (h === "internal.example.com" ? ["192.168.0.9"] : ["93.184.216.34"]);
    expect(await safeGet("https://a.example.com/", f, { ...opts, lookup })).toBeUndefined();
  });

  it("gives up after 5 redirects", async () => {
    const { f, calls } = routed({ "https://a.example.com/": () => redirect("https://a.example.com/") });
    expect(await safeGet("https://a.example.com/", f, opts)).toBeUndefined();
    expect(calls).toHaveLength(6);
  });

  it("follows a legitimate redirect and caps the streamed body", async () => {
    const { f } = routed({ "https://a.example.com/": () => redirect("/b"), "https://a.example.com/b": () => html("x".repeat(5000)) });
    const r = await safeGet("https://a.example.com/", f, opts);
    expect(r?.finalUrl).toBe("https://a.example.com/b");
    expect(r?.body.length).toBe(1000);
  });
});
