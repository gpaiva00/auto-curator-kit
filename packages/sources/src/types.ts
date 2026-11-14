import type { Logger } from "@auto-curator/contracts";
import type { PageReader } from "./browser/cdp.js";

/** What every source factory may receive. `fetch`, `pageReader` and `sleep` exist to inject fakes in tests. */
export interface SourceDeps {
  env: NodeJS.ProcessEnv;
  logger: Logger;
  fetch?: typeof fetch;
  /** Replaces the Chrome (CDP) reader used by x-feed and instagram-profile. */
  pageReader?: PageReader;
  sleep?: (ms: number) => Promise<void>;
}
