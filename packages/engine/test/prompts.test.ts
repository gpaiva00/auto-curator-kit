import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilePromptProvider, PromptMissingError } from "../src/index.js";
import { makeBundle } from "../src/testing.js";
import { tmp } from "./helpers.js";

function dirs() {
  const root = tmp();
  const profileDir = join(root, "p");
  const templateDir = join(root, "t");
  mkdirSync(join(profileDir, "prompts"), { recursive: true });
  mkdirSync(join(templateDir, "prompts"), { recursive: true });
  writeFileSync(join(templateDir, "prompts", "curator.md"), "# CURATOR (prompt v3)\nbase");
  return { profileDir, templateDir };
}

describe("FilePromptProvider", () => {
  it("assembles template prompt + style guide + profile rules, with version", () => {
    const { profileDir, templateDir } = dirs();
    writeFileSync(join(profileDir, "style-guide.md"), "Seja direto.");
    const b = makeBundle(tmp(), { editorial: { credit: "show", riskFlags: ["a"], forceReview: ["a"], firstComment: true } as never });
    const p = new FilePromptProvider({ profileDir, templateDir, profile: b.profile, draftExtraRequired: ["categoryTag"] });
    const r = p.get("curator");
    expect(r.text).toContain("# CURATOR (prompt v3)");
    expect(r.text).toContain("STYLE GUIDE");
    expect(r.text).toContain("Seja direto.");
    expect(r.text).toContain("PROFILE RULES");
    expect(r.text).toContain("categoryTag");
    expect(r.text).toContain("ALWAYS fill sourceCredit");
    expect(r.version).toMatch(/^curator v3 [0-9a-f]{8}$/);
  });

  it("prefers the profile prompt and omits style guide when absent", () => {
    const { profileDir, templateDir } = dirs();
    writeFileSync(join(profileDir, "prompts", "curator.md"), "# CURATOR (prompt v7)\nmine");
    const p = new FilePromptProvider({ profileDir, templateDir, profile: makeBundle(tmp()).profile });
    const r = p.get("curator");
    expect(r.text).toContain("mine");
    expect(r.text).not.toContain("STYLE GUIDE");
    expect(r.version).toContain("v7");
  });

  it("throws when the prompt is missing", () => {
    const { profileDir, templateDir } = dirs();
    const p = new FilePromptProvider({ profileDir, templateDir, profile: makeBundle(tmp()).profile });
    expect(() => p.get("triage")).toThrow(PromptMissingError);
  });
});
