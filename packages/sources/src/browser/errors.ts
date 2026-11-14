import { KitError } from "@auto-curator/contracts";

export type BrowserErrorKind = "NOT_AVAILABLE" | "AUTH_REQUIRED" | "RATE_LIMITED" | "NOT_FOUND" | "FAILED";

/** Browser-source failure. `kind` tells the caller whether to stop the whole run (everything but NOT_FOUND/FAILED). */
export class BrowserError extends KitError {
  constructor(message: string, readonly kind: BrowserErrorKind) {
    super(message, `BROWSER_${kind}`);
    this.name = "BrowserError";
  }
}

/** Errors after which more reads in the same run would only make things worse. */
export const isStopError = (e: unknown): e is BrowserError => e instanceof BrowserError && (e.kind === "NOT_AVAILABLE" || e.kind === "AUTH_REQUIRED" || e.kind === "RATE_LIMITED");
