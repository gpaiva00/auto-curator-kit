import type { Destination, Item, MediaHost, PreparedMedia, PublishRequest } from "@auto-curator/contracts";
import { Destination as DestinationSchema } from "@auto-curator/contracts";

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** Records every request and answers with whatever `route` returns. */
export function fakeFetch(route: (req: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const rec: Recorded = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    };
    calls.push(rec);
    return route(rec);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** Routes Buffer GraphQL calls by the operation they carry. */
export function bufferRoute(opts: {
  orgs?: { id: string }[];
  channels?: Record<string, { id: string; service: string; isDisconnected?: boolean }[]>;
  createPost?: (input: any) => Response | { post?: { id: string }; message?: string };
}) {
  return (req: Recorded): Response => {
    const q: string = req.body.query;
    if (q.includes("account {")) return json({ data: { account: { organizations: opts.orgs ?? [{ id: "o1" }] } } });
    if (q.includes("channels(")) {
      const org = req.body.variables.organizationId as string;
      return json({ data: { channels: opts.channels?.[org] ?? [] } });
    }
    const input = req.body.variables.input;
    const out = opts.createPost ? opts.createPost(input) : { post: { id: "p1" } };
    if (out instanceof Response) return out;
    return json({ data: { createPost: out } });
  };
}

export const item = () => ({ id: "i1" }) as unknown as Item;

export const dest = (o: Partial<Destination> = {}) => DestinationSchema.parse({ platform: "instagram", publisher: "buffer", ...o });

export const photo = (name = "a.jpg", platform?: string): PreparedMedia => ({ type: "image", localPath: `/tmp/${name}`, thirdParty: false, ...(platform ? { platform } : {}) });
export const clip = (name = "v.mp4"): PreparedMedia => ({ type: "video", localPath: `/tmp/${name}`, thirdParty: false });

export function req(o: Partial<PublishRequest> & { destination?: Destination } = {}): PublishRequest {
  return { item: item(), destination: dest(), text: "texto do post", media: [], ...o };
}

/** Host that takes images only and names the uploaded file by its basename. */
export const imageHost = (): MediaHost & { uploads: string[] } => {
  const uploads: string[] = [];
  return {
    name: "fake",
    uploads,
    supports: (k) => k === "image",
    upload: async (p) => {
      uploads.push(p);
      return `https://cdn.test/${p.split("/").pop()}`;
    },
  };
};
