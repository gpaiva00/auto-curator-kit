import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileConfigInput } from "@auto-curator/contracts";
import { App, FakeLlm, FakePreparer, FakePublisher, RecordingNotifier, Store, StaticPromptProvider, fixedClock, makeBundle, okDraft, type FakeSource } from "../src/index.js";

export const tmp = (): string => mkdtempSync(join(tmpdir(), "engine-"));

export function setup(opts: { profile?: Partial<ProfileConfigInput>; llm?: FakeLlm; sources?: FakeSource[]; media?: "none" | "image" | "image+video"; extraRequired?: string[] } = {}) {
  const clock = fixedClock();
  const store = new Store({ path: ":memory:", clock });
  const bundle = makeBundle(tmp(), opts.profile, { draftExtraRequired: opts.extraRequired ?? [] });
  const llm = opts.llm ?? new FakeLlm({ curator: okDraft() });
  const notifier = new RecordingNotifier();
  const buffer = new FakePublisher("buffer");
  const preparer = new FakePreparer(opts.media ?? "image");
  const app = new App({ bundle, store, llm, prompts: new StaticPromptProvider(), sources: opts.sources ?? [], preparer, publishers: { buffer }, notifier, clock });
  return { app, store, llm, notifier, buffer, preparer, clock, bundle };
}
