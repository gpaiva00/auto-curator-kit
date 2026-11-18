// Bootstrap: roda antes de qualquer import pesado. Não importa o engine.
import { runtimeProblem } from "@auto-curator/contracts/runtime";

export function assertRuntime(): void {
  const problem = runtimeProblem({ node: process.versions.node, bun: process.versions.bun });
  if (problem) {
    console.error(`❌ ${problem}`);
    process.exit(1);
  }
}
