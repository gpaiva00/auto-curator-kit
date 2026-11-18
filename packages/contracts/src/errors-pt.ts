import { z } from "zod";

const TIPO: Record<string, string> = { string: "texto", number: "número", boolean: "verdadeiro/falso", array: "lista", object: "objeto", null: "nulo" };
const tipo = (t: string): string => TIPO[t] ?? t;

/** Mensagens de erro do zod em português (usadas na carga do perfil e dos modelos). */
export const ptErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === "undefined") return { message: "campo obrigatório" };
      return { message: `esperado ${tipo(issue.expected)}, recebido ${tipo(issue.received)}` };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: `chave desconhecida: ${issue.keys.map((k) => `"${k}"`).join(", ")}` };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `valor inválido; use um de: ${issue.options.join(", ")}` };
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === "url") return { message: "URL inválida" };
      if (issue.validation === "regex") return { message: "formato inválido" };
      return { message: ctx.defaultError };
    case z.ZodIssueCode.too_small:
      if (issue.type === "string") return { message: "não pode ser vazio" };
      if (issue.type === "array") return { message: `precisa de pelo menos ${issue.minimum} item(ns)` };
      return { message: `deve ser maior ou igual a ${issue.minimum}` };
    case z.ZodIssueCode.too_big:
      if (issue.type === "string") return { message: `não pode passar de ${issue.maximum} caracteres` };
      return { message: `deve ser menor ou igual a ${issue.maximum}` };
    default:
      return { message: ctx.defaultError };
  }
};

/** "sources[2].tipe" a partir do caminho do zod. */
export function formatIssuePath(path: readonly (string | number)[]): string {
  return path.reduce<string>((acc, p) => (typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p), "");
}
