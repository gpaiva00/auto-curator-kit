import { isIP } from "node:net";
import { DownloaderError } from "./errors.js";
import { isPrivateIp } from "./net.js";

const MAX_URL_LENGTH = 2048;

/** Hostnames that must never be fetched on behalf of an item (loopback, link-local, private ranges). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  if (isIP(h)) return isPrivateIp(h);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

/** Accepts only plain https URLs (no credentials, no private hosts, printable ASCII). Returns the normalized URL. */
export function validateMediaUrl(input: unknown, opts: { allowHttp?: boolean } = {}): string {
  const bad = (why: string): never => {
    throw new DownloaderError(`URL invalida: ${why}`, "INVALID_URL");
  };
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_URL_LENGTH) return bad("tamanho");
  if (!/^[\x21-\x7e]+$/.test(input) || input.includes("\\")) return bad("caracteres ilegais");
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return bad("nao e uma URL");
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) return bad("somente https");
  if (u.username || u.password) return bad("credenciais na URL");
  if (isPrivateHost(u.hostname)) return bad("host privado");
  return u.toString();
}
