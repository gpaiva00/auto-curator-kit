import type { Draft, Item, PrepareContext, PreparedMedia, Preparer } from "@auto-curator/contracts";

/** Text-only profiles: no media at all. */
export class NonePreparer implements Preparer {
  readonly strategy = "none" as const;
  async prepare(_item: Item, _draft: Draft, _ctx: PrepareContext): Promise<PreparedMedia[]> {
    return [];
  }
}
