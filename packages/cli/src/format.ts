/** "R$ 1,50" (pt-BR decimal comma). */
export const brl = (n: number, digits = 2): string => `R$ ${n.toFixed(digits).replace(".", ",")}`;
