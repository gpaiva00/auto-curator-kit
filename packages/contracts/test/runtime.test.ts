import { describe, expect, it } from "vitest";
import { runtimeProblem } from "../src/runtime.js";

describe("runtimeProblem", () => {
  it("aceita o piso 22.13.0, 23.4+ e 24+", () => {
    expect(runtimeProblem({ node: "22.13.0" })).toBeNull();
    expect(runtimeProblem({ node: "22.20.1" })).toBeNull();
    expect(runtimeProblem({ node: "23.4.0" })).toBeNull();
    expect(runtimeProblem({ node: "26.0.0" })).toBeNull();
  });
  it("recusa 22.12, 23.0–23.3 e Bun, em português", () => {
    expect(runtimeProblem({ node: "22.12.0" })).toMatch(/22\.12\.0 não é suportado/);
    expect(runtimeProblem({ node: "23.3.0" })).toMatch(/não é suportado/);
    expect(runtimeProblem({ node: "26.0.0", bun: "1.3.13" })).toMatch(/Bun 1\.3\.13: rode com node/);
  });
});
