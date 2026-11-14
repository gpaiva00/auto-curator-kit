import { z } from "zod";
import { Media, Origin, type Draft, type Verdict } from "@auto-curator/contracts";

const VerdictEnum = z.enum(["publish", "needs_human", "skip"]);
const strings = z.array(z.string()).optional();

export const EvalExpect = z.object({
  verdict: VerdictEnum,
  /** Other verdicts that also count as a pass. */
  alsoAcceptable: z.array(VerdictEnum).optional(),
  /** riskFlags that must be present (only checked when the model actually produced a draft). */
  mustFlag: strings,
  headlineMustInclude: strings,
  headlineMustNotInclude: strings,
  sourceCreditMustInclude: strings,
  sourceCreditMustNotInclude: strings,
  bodyMustInclude: strings,
  bodyMustNotInclude: strings,
});
export type EvalExpect = z.infer<typeof EvalExpect>;

export const EvalItem = z.object({
  id: z.string().default("eval"),
  origin: Origin.optional(),
  source: z.string().default("eval"),
  sourceUrl: z.string().optional(),
  author: z.string().default(""),
  title: z.string().nullish(),
  text: z.string(),
  media: z.array(Media).default([]),
  postedAt: z.string().nullish(),
  engagement: z.object({ likes: z.number().optional(), comments: z.number().optional(), shares: z.number().optional() }).default({}),
  extra: z.record(z.unknown()).default({}),
});
export type EvalItem = z.infer<typeof EvalItem>;

/** Accepts `expect` (documented) or `expected` (what the shipped template cases use). */
export const EvalCase = z
  .object({ name: z.string().min(1), item: EvalItem, expect: EvalExpect.optional(), expected: EvalExpect.optional(), note: z.string().optional() })
  .refine((c) => c.expect || c.expected, { message: 'o caso precisa de "expect"' })
  .transform((c) => ({ name: c.name, item: c.item, expect: (c.expect ?? c.expected)!, note: c.note }));
export type EvalCase = z.output<typeof EvalCase>;

export const EvalFile = z.array(EvalCase);

const has = (text: string | undefined, needle: string): boolean => (text ?? "").toLowerCase().includes(needle.toLowerCase());

/**
 * Pure matcher. `finalVerdict` is what the pipeline would do (after the editorial policy); `draft` is the policy-adjusted
 * draft, or undefined when no LLM call happened (pre-filter skip) or it failed. Returns the problems (empty = pass), in pt-BR.
 */
export function checkCase(expect: EvalExpect, finalVerdict: Verdict | "error", draft: Draft | undefined): string[] {
  const problems: string[] = [];
  const accepted: string[] = [expect.verdict, ...(expect.alsoAcceptable ?? [])];
  if (!accepted.includes(finalVerdict)) problems.push(`veredito ${finalVerdict}, esperado ${accepted.join(" ou ")}`);
  if (!draft) return problems; // text checks only make sense with a draft

  for (const t of expect.headlineMustInclude ?? []) if (!has(draft.headline, t)) problems.push(`título sem "${t}"`);
  for (const t of expect.headlineMustNotInclude ?? []) if (has(draft.headline, t)) problems.push(`título contém "${t}"`);
  for (const t of expect.sourceCreditMustInclude ?? []) if (!has(draft.sourceCredit, t)) problems.push(`crédito sem "${t}"`);
  for (const t of expect.sourceCreditMustNotInclude ?? []) if (has(draft.sourceCredit, t)) problems.push(`crédito contém "${t}"`);
  for (const t of expect.bodyMustInclude ?? []) if (!has(draft.body, t)) problems.push(`texto sem "${t}"`);
  for (const t of expect.bodyMustNotInclude ?? []) if (has(draft.body, t)) problems.push(`texto contém "${t}"`);
  const flags = draft.riskFlags.map((f) => f.toLowerCase());
  for (const f of expect.mustFlag ?? []) if (!flags.includes(f.toLowerCase())) problems.push(`faltou a flag ${f}`);
  return problems;
}
