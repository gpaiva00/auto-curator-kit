import {
  errMsg,
  PublishError,
  type Destination,
  type MediaHost,
  type PreparedMedia,
  type PublishRequest,
  type PublishResult,
  type Publisher,
} from "@auto-curator/contracts";

/** Buffer GraphQL API. Same endpoint and mutation as the perfil-noticias and linkedin-curador clients. */
const ENDPOINT = "https://api.buffer.com";
const TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_AFTER_SEC = 900;

const CREATE_POST = `
mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess { post { id } }
    ... on MutationError { message }
  }
}`;

const ORGANIZATIONS = "query { account { organizations { id name } } }";
const CHANNELS = "query($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id name service isDisconnected } }";

/** Platform name -> Buffer service name, where they differ. */
const SERVICE_ALIAS: Record<string, string> = { x: "twitter" };

export interface BufferPublisherOptions {
  apiKey: string;
  /** Buffer channel id per platform (e.g. { linkedin: "abc" }). Missing platforms are discovered from the account. */
  channels: Record<string, string>;
  mediaHost?: MediaHost;
  fetch?: typeof fetch;
  endpoint?: string;
}

interface BufferChannel {
  id: string;
  name?: string;
  service?: string;
  isDisconnected?: boolean;
}

interface GqlEnvelope<T> {
  data?: T;
  errors?: { message: string }[];
}

/** Envvar that holds the channel of a platform: BUFFER_CHANNEL_<PLATFORM>. */
export const channelEnvName = (platform: string): string => `BUFFER_CHANNEL_${platform.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

/**
 * Schedules posts through Buffer. `destination.mode` maps to Buffer's API as the existing clients do:
 * draft = addToQueue + saveToDraft, queue = addToQueue, now = shareNow.
 */
export class BufferPublisher implements Publisher {
  readonly name = "buffer";
  private readonly discovered = new Map<string, string>();
  private readonly f: typeof fetch;

  constructor(private readonly o: BufferPublisherOptions) {
    this.f = o.fetch ?? fetch;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const platform = req.destination.platform;
    const mode = req.destination.mode ?? "draft";
    const plan = this.planMedia(req);
    if (platform === "tiktok" && !plan.attach.some((m) => m.type === "video")) {
      throw new PublishError("Buffer: TikTok exige um vídeo anexado, e nenhum vídeo compatível foi enviado.");
    }
    const channelId = await this.channelFor(platform);

    const assets: { type: PreparedMedia["type"]; url: string }[] = [];
    for (const m of plan.attach) assets.push({ type: m.type, url: await this.upload(m) });

    const input: Record<string, unknown> = {
      channelId,
      text: req.text,
      schedulingType: "automatic",
      mode: mode === "now" ? "shareNow" : "addToQueue",
      needsApproval: false,
      assets: assets.map((a) => (a.type === "video" ? { video: { url: a.url } } : { image: { url: a.url } })),
      ...(mode === "draft" ? { saveToDraft: true } : {}),
    };
    const metadata = metadataFor(platform, assets[0]?.type, req.firstComment);
    if (metadata) input.metadata = metadata;

    const data = await this.gql<{ createPost?: { post?: { id?: string }; message?: string } }>(CREATE_POST, { input });
    const id = data.createPost?.post?.id;
    if (!id) throw new PublishError(`Buffer: ${data.createPost?.message ?? "createPost não devolveu o post"}`);

    return { externalId: id, mode, ...(plan.dropped > 0 ? { droppedMedia: plan.dropped } : {}) };
  }

  /** req.media is already selected for this destination by the engine; items the host cannot take are dropped. */
  private planMedia(req: PublishRequest): { attach: PreparedMedia[]; dropped: number } {
    const eligible = req.media;
    const host = this.o.mediaHost;
    if (!host) return { attach: [], dropped: eligible.length };
    const attach = eligible.filter((m) => host.supports(m.type));
    return { attach, dropped: eligible.length - attach.length };
  }

  private async upload(m: PreparedMedia): Promise<string> {
    try {
      return await this.o.mediaHost!.upload(m.localPath);
    } catch (e) {
      throw new PublishError(`Buffer: falha ao enviar a mídia para o host (${errMsg(e)})`);
    }
  }

  /** Channel id used for a platform: the configured one, else discovered in the account (throws PublishError when ambiguous or missing). */
  resolveChannel(platform: string): Promise<string> {
    return this.channelFor(platform);
  }

  private async channelFor(platform: string): Promise<string> {
    const configured = Object.hasOwn(this.o.channels, platform) ? this.o.channels[platform]?.trim() : undefined;
    if (configured) return configured;
    const known = this.discovered.get(platform);
    if (known) return known;
    const found = await this.discover(platform);
    this.discovered.set(platform, found);
    return found;
  }

  /** Looks for the single connected channel of this platform across every organization of the account. */
  private async discover(platform: string): Promise<string> {
    const service = SERVICE_ALIAS[platform] ?? platform;
    const env = channelEnvName(platform);
    const orgs = await this.gql<{ account: { organizations: { id: string }[] } }>(ORGANIZATIONS);
    const matches: BufferChannel[] = [];
    for (const org of orgs.account.organizations) {
      const r = await this.gql<{ channels: BufferChannel[] }>(CHANNELS, { organizationId: org.id });
      for (const c of r.channels) {
        if ((c.service ?? "").toLowerCase() === service && !c.isDisconnected) matches.push(c);
      }
    }
    if (matches.length === 0) {
      throw new PublishError(`Buffer: nenhum canal de ${platform} conectado na conta. Conecte o canal no Buffer ou defina ${env}.`, { fatal: true });
    }
    if (matches.length > 1) {
      throw new PublishError(`Buffer: há ${matches.length} canais de ${platform} conectados. Defina ${env} para escolher um.`, { fatal: true });
    }
    return matches[0]!.id;
  }

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.f(this.o.endpoint ?? ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new PublishError(`Buffer: falha de rede (${errMsg(e)})`);
    }
    if (res.status === 429) {
      throw new PublishError("Buffer: limite de requisições atingido. A publicação será tentada depois.", {
        retryAfterSec: retryAfterSec(res),
        fatal: true,
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw new PublishError(`Buffer recusou a chave de API (HTTP ${res.status}). Verifique BUFFER_API_KEY.`, { fatal: true });
    }
    const body = (await res.json().catch(() => undefined)) as GqlEnvelope<T> | undefined;
    if (!res.ok) throw new PublishError(`Buffer respondeu HTTP ${res.status}`);
    if (body?.errors?.length) throw new PublishError(`Buffer: ${body.errors.map((e) => e.message).join("; ")}`);
    if (!body?.data) throw new PublishError("Buffer: resposta vazia");
    return body.data;
  }
}

function retryAfterSec(res: Response): number {
  const raw = Number(res.headers.get("retry-after"));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETRY_AFTER_SEC;
}

/** Per-platform metadata, as in perfil-noticias (instagram, tiktok) and linkedin-curador (first comment). */
function metadataFor(platform: string, kind: PreparedMedia["type"] | undefined, firstComment?: string): Record<string, unknown> | undefined {
  if (platform === "linkedin") return firstComment ? { linkedin: { firstComment } } : undefined;
  if (platform === "instagram") return { instagram: { type: kind === "video" ? "reel" : "post", shouldShareToFeed: true } };
  if (platform === "tiktok") return { tiktok: { isAiGenerated: false } };
  return undefined;
}

/**
 * Channel ids from env: BUFFER_CHANNEL_<PLATFORM>, or the envvar named by destination.channelEnv.
 * Unset or empty variables are left out, so those platforms fall back to discovery.
 */
export function channelsFromEnv(
  env: NodeJS.ProcessEnv,
  platforms: readonly (string | Pick<Destination, "platform" | "channelEnv">)[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of platforms) {
    const platform = typeof p === "string" ? p : p.platform;
    const name = (typeof p === "string" ? undefined : p.channelEnv) || channelEnvName(platform);
    const value = env[name]?.trim();
    if (value) out[platform] = value;
  }
  return out;
}

export interface BufferFromEnvOptions {
  fetch?: typeof fetch;
  endpoint?: string;
}

/** Returns undefined when BUFFER_API_KEY is empty (the manual flow stays in charge). Only buffer destinations are considered. */
export function createBufferFromEnv(
  env: NodeJS.ProcessEnv,
  destinations: readonly Destination[],
  mediaHost?: MediaHost,
  opts: BufferFromEnvOptions = {},
): BufferPublisher | undefined {
  const apiKey = env.BUFFER_API_KEY?.trim();
  if (!apiKey) return undefined;
  const buffered = destinations.filter((d) => d.publisher === "buffer");
  return new BufferPublisher({ apiKey, channels: channelsFromEnv(env, buffered), mediaHost, fetch: opts.fetch, endpoint: opts.endpoint });
}
