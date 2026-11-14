import { z } from "zod";

/** Models often write "#Celso Portiolli" or "celso"; fix the shape instead of failing the whole post. */
export const normalizeHashtag = (v: unknown): unknown => (typeof v === "string" ? `#${v.replace(/\s+/g, "").replace(/^#+/, "")}` : v);
export const Hashtag = z.preprocess(normalizeHashtag, z.string().regex(/^#\S+$/, 'hashtag must be "#word" with no spaces'));

export const Verdict = z.enum(["publish", "needs_human", "skip"]);
export type Verdict = z.infer<typeof Verdict>;

/**
 * The Curator's output, common to every profile. Niche-specific fields go in `extra`
 * (the template lists which `extra` keys are required, see TemplateConfig.draftExtraRequired).
 * Length/flag limits come from the profile (EditorialConfig) and are enforced by the engine policy, not here.
 */
export const Draft = z.object({
  verdict: Verdict,
  skipReason: z.string().optional(),
  /** Short title: label of the approval message and headline of a rendered card. */
  headline: z.string().min(1).max(200),
  /** Text exactly as it will be published (Instagram caption, LinkedIn post...), without hashtags and credit. */
  body: z.string().max(5000),
  hashtags: z.array(Hashtag).default([]),
  /** Required when editorial.credit = "show" (e.g. "Reprodução Instagram @handle"). */
  sourceCredit: z.string().optional(),
  firstComment: z.string().max(1000).optional(),
  facts: z.array(z.object({ claim: z.string(), sourceUrl: z.string() })).default([]),
  riskFlags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  /** Doubts or changes the human should know about (pt-BR). */
  notes: z.string().max(1000).default(""),
  /** Template-specific fields (categoryTag, mediaPlan, urgency...). */
  extra: z.record(z.unknown()).default({}),
  /** Set by the engine: "<role> v<N> <sha8>". */
  promptVersion: z.string().optional(),
});
export type Draft = z.infer<typeof Draft>;
export type DraftInput = z.input<typeof Draft>;

/** Triage output: one entry per item. */
export const TriageEntry = z.object({
  id: z.string(),
  score: z.number().min(0).max(100),
  reason: z.string().default(""),
});
export type TriageEntry = z.infer<typeof TriageEntry>;

/**
 * Final text as it will be posted: body, blank line, hashtags, blank line, credit (when shown).
 * The body is not repeated if the model already ended it with the credit line.
 */
export function composeText(d: Pick<Draft, "body" | "hashtags" | "sourceCredit">, opts: { credit: "show" | "hide" } = { credit: "hide" }): string {
  const lines = d.body.trimEnd().split("\n");
  const credit = opts.credit === "show" ? d.sourceCredit?.trim() : undefined;
  if (credit && lines.length > 1 && lines[lines.length - 1]!.trim() === credit) lines.pop();
  const parts = [lines.join("\n").trim()];
  if (d.hashtags.length) parts.push(d.hashtags.join(" "));
  if (credit) parts.push(credit);
  return parts.join("\n\n");
}
