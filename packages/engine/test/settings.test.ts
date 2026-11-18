import { mkdtempSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { saveProfileSetting, SettingError } from "../src/settings.js";

const example = resolve(__dirname, "../../../profiles/linkedin-exemplo");

function tmpProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), "settings-"));
  copyFileSync(join(example, "profile.json"), join(dir, "profile.json"));
  copyFileSync(join(example, "style-guide.md"), join(dir, "style-guide.md"));
  return dir;
}

describe("saveProfileSetting", () => {
  it("writes a whitelisted setting into profile.json", () => {
    const dir = tmpProfile();
    const v = saveProfileSetting(dir, "aprovacoes_dia", "5");
    expect(v).toMatchObject({ key: "aprovacoes_dia", path: "pipeline.dailyApprovalCap", value: 5 });
    expect(JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")).pipeline.dailyApprovalCap).toBe(5);
    saveProfileSetting(dir, "confianca_minima", "0,7");
    expect(JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")).editorial.minConfidence).toBe(0.7);
  });

  it("refuses unknown keys, out-of-range numbers and invalid timezones", () => {
    const dir = tmpProfile();
    expect(() => saveProfileSetting(dir, "api_key", "x")).toThrow(SettingError);
    expect(() => saveProfileSetting(dir, "triagem_minima", "150")).toThrow(/intervalo/);
    expect(() => saveProfileSetting(dir, "aprovacoes_dia", "2.5")).toThrow(/inteiro/);
    expect(() => saveProfileSetting(dir, "fuso", "Marte/Base")).toThrow(/Fuso/);
  });
});
