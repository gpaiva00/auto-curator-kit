import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listProfileIds, resolveProfile } from "../src/profile.js";
import { REPO_PROFILES, tmpDir } from "./helpers.js";

function fakeRoot() {
  const root = tmpDir();
  for (const id of ["alfa", "beta"]) {
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, "profile.json"), "{}");
  }
  return root;
}

describe("profile resolution", () => {
  it("resolves an id under the profiles root", () => {
    const root = fakeRoot();
    expect(resolveProfile("alfa", {}, root)).toBe(join(root, "alfa"));
  });

  it("resolves a path (absolute and relative to cwd)", () => {
    const root = fakeRoot();
    expect(resolveProfile(join(root, "beta"), {}, "/nada")).toBe(join(root, "beta"));
    const rel = join(root, "beta");
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(realpathSync(resolveProfile("./beta", {}, "/nada"))).toBe(realpathSync(resolve(rel)));
    } finally {
      process.chdir(cwd);
    }
  });

  it("falls back to CURADOR_PROFILE, and --profile wins over it", () => {
    const root = fakeRoot();
    expect(resolveProfile(undefined, { CURADOR_PROFILE: "beta" }, root)).toBe(join(root, "beta"));
    expect(resolveProfile("alfa", { CURADOR_PROFILE: "beta" }, root)).toBe(join(root, "alfa"));
  });

  it("errors list the available profiles", () => {
    const root = fakeRoot();
    expect(() => resolveProfile(undefined, {}, root)).toThrow(/--profile.*alfa, beta/s);
    expect(() => resolveProfile("zeta", {}, root)).toThrow(/não encontrado.*alfa, beta/s);
  });

  it("finds the shipped example profiles", () => {
    expect(listProfileIds(REPO_PROFILES)).toContain("astronomia");
    expect(resolveProfile("astronomia", {}, REPO_PROFILES)).toBe(join(REPO_PROFILES, "astronomia"));
    expect(resolveProfile("profiles/astronomia", {}, "/nada")).toBe(join(REPO_PROFILES, "astronomia"));
  });
});
