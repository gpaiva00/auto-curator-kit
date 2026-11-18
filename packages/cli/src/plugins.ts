import type { MediaHost, Publisher } from "@auto-curator/contracts";
import type { SourcePlugin } from "@auto-curator/sources";

/** Pontos de extensão do projeto (seção 3). Sem registro global obrigatório. */
export interface KitPlugins {
  /** type -> fábrica de Source (ou { factory, override: true } para substituir um tipo do kit). */
  sources?: Record<string, SourcePlugin>;
  /** id -> Publisher, ou função (env, host) que devolve esse mapa. Sem isto, vale o Buffer pelo .env. */
  publishers?: Record<string, Publisher> | ((env: NodeJS.ProcessEnv, host: MediaHost | undefined) => Record<string, Publisher>);
  /** Substitui createMediaHostFromEnv. */
  mediaHost?: MediaHost | ((env: NodeJS.ProcessEnv) => MediaHost | undefined);
}
