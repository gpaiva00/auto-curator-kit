/** Versões aceitas: Node 22.13.0+ (node:sqlite sem flag) ou 23.4.0+. Bun não carrega node:sqlite. */
export function runtimeProblem(versions: { node: string; bun?: string }): string | null {
  if (versions.bun) return `O auto-curator-kit roda sob Node (22.13.0 ou superior). Você está usando Bun ${versions.bun}: rode com node.`;
  const [major = 0, minor = 0] = versions.node.split(".").map(Number);
  if ((major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major >= 24) return null;
  return `Node ${versions.node} não é suportado. Use Node 22.13.0 ou superior (ou 23.4.0 e posteriores): o kit usa node:sqlite.`;
}
