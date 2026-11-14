import { describe, expect, it } from "vitest";
import { bufferIo } from "../src/io.js";
import { run } from "../src/main.js";
import { cleanEnv, REPO_PROFILES, tmpDir } from "./helpers.js";

describe("dry-run", () => {
  it("runs the whole pipeline on astronomia: pending_approval -> approved/published, one rejected, one skipped", async () => {
    const io = bufferIo();
    const code = await run(["dry-run", "--profile", "astronomia"], cleanEnv(tmpDir()), io, REPO_PROFILES);
    const t = io.text();
    expect(t).toContain("ready → pending_approval");
    expect(t).toContain("pending_approval → approved");
    expect(t).toContain("approved → published");
    expect(t).toContain("pending_approval → rejected");
    expect(t).toContain("new → skipped");
    expect(t).toContain("Confiança 90%");
    expect(t).toContain("dry-run completo");
    expect(code).toBe(0);
  });

  it("works without a profile (synthetic one, manual destination)", async () => {
    const io = bufferIo();
    const code = await run(["dry-run"], cleanEnv(tmpDir()), io, REPO_PROFILES);
    expect(io.text()).toContain("pending_approval → approved");
    expect(code).toBe(0);
  });

  it("works on the thought-leader example profile (credit hidden)", async () => {
    const io = bufferIo();
    const code = await run(["dry-run", "--profile", "linkedin-exemplo"], cleanEnv(tmpDir()), io, REPO_PROFILES);
    expect(io.text()).toContain("pending_approval");
    expect(code).toBe(0);
  });
});
