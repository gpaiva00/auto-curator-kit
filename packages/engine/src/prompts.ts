import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KitError, type LlmRole, type ProfileConfig, type PromptProvider } from "@auto-curator/contracts";
import { sha256 } from "./util.js";

export class PromptMissingError extends KitError {
  constructor(file: string) {
    super(`Prompt não encontrado: ${file}. Crie o arquivo no perfil (prompts/<papel>.md) ou no template.`, "PROMPT_MISSING");
    this.name = "PromptMissingError";
  }
}

/** Version number from the "# ROLE (prompt vN)" header (first 5 lines), "?" when absent. */
export function promptVersionNumber(text: string): string {
  const head = text.split("\n", 5).join("\n");
  return /\(prompt v(\d+)\)/i.exec(head)?.[1] ?? "?";
}

/** Generated from the editorial config so the model knows the same limits the code enforces. */
export function profileRulesBlock(profile: ProfileConfig, draftExtraRequired: string[] = []): string {
  const e = profile.editorial;
  const lines = [
    `Profile: ${profile.name} (language: ${profile.language}).`,
    e.credit === "show"
      ? "- Source credit: ALWAYS fill sourceCredit (e.g. \"Fonte: <author or outlet>\"); it is shown in the post."
      : "- Source credit: do NOT credit the source in the text; write as the profile's own content (sourceCredit may be empty).",
    `- Allowed riskFlags (use only these): ${e.riskFlags.length ? e.riskFlags.join(", ") : "(none)"}.`,
    `- Flags that force human review (verdict needs_human): ${e.forceReview.length ? e.forceReview.join(", ") : "(none)"}.`,
    `- Flags that force skip (verdict skip): ${e.skip.length ? e.skip.join(", ") : "(none)"}.`,
    `- Confidence below ${e.minConfidence} forces human review.`,
    `- headline: at most ${e.headline.maxChars} characters.`,
    `- body: ${e.body.minChars} to ${e.body.maxChars} characters.`,
    `- hashtags: between ${e.hashtags.min} and ${e.hashtags.max}.`,
    `- firstComment: ${e.firstComment ? "allowed (optional)" : "NOT allowed, leave it out"}.`,
  ];
  if (draftExtraRequired.length) lines.push(`- extra must contain these keys: ${draftExtraRequired.join(", ")}.`);
  return lines.join("\n");
}

export interface FilePromptDeps {
  profileDir: string;
  templateDir: string;
  profile: ProfileConfig;
  draftExtraRequired?: string[];
}

/**
 * prompts/<role>.md from the profile if it exists, else the template's; plus the profile's style-guide.md and a generated
 * PROFILE RULES block. Files are read on every call, so prompts can be tweaked without restarting.
 */
export class FilePromptProvider implements PromptProvider {
  constructor(private readonly d: FilePromptDeps) {}

  get(role: LlmRole): { text: string; version: string } {
    const own = join(this.d.profileDir, "prompts", `${role}.md`);
    const file = existsSync(own) ? own : join(this.d.templateDir, "prompts", `${role}.md`);
    if (!existsSync(file)) throw new PromptMissingError(file);
    const base = readFileSync(file, "utf8").trim();
    if (!base) throw new PromptMissingError(`${file} (arquivo vazio)`);

    const parts = [base];
    const styleFile = join(this.d.profileDir, "style-guide.md");
    if (existsSync(styleFile)) {
      const style = readFileSync(styleFile, "utf8").trim();
      if (style) parts.push(`---\nSTYLE GUIDE (the owner's voice, topics and audience)\n\n${style}`);
    }
    parts.push(`---\nPROFILE RULES (enforced by code after your answer)\n\n${profileRulesBlock(this.d.profile, this.d.draftExtraRequired)}`);
    const text = parts.join("\n\n");
    return { text, version: `${role} v${promptVersionNumber(base)} ${sha256(text).slice(0, 8)}` };
  }
}

/** Fixed prompts (tests, dry-run). */
export class StaticPromptProvider implements PromptProvider {
  constructor(private readonly prompts: Record<LlmRole, string> = { triage: "# TRIAGE (prompt v1)", curator: "# CURATOR (prompt v1)" }) {}
  get(role: LlmRole): { text: string; version: string } {
    const text = this.prompts[role];
    return { text, version: `${role} v${promptVersionNumber(text)} ${sha256(text).slice(0, 8)}` };
  }
}
