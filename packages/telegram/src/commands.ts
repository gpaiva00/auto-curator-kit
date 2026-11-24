/** Single table: drives setMyCommands, /ajuda and dispatch. `name` is registered in the "/" menu; aliases only dispatch. */
export const BOT_COMMANDS = [
  { name: "add", aliases: [], args: "<link ou texto>", description: "Cria um item agora (colar só o link também funciona)" },
  { name: "ler", aliases: ["scan"], args: "", description: "Roda as fontes agora" },
  { name: "pendentes", aliases: ["pending"], args: "", description: "O que espera a sua aprovação" },
  { name: "fila", aliases: ["queue"], args: "", description: "Tudo em andamento, agrupado por status" },
  { name: "agenda", aliases: ["schedule"], args: "", description: "O que está agendado no Buffer" },
  { name: "refazer", aliases: [], args: "<id> <instrução>", description: "Refaz o texto de um item antes de sair (sem fila de envio)" },
  { name: "furar", aliases: ["bump"], args: "<id>", description: "Põe um item na frente da fila" },
  { name: "desfurar", aliases: ["unbump"], args: "<id>", description: "Tira a prioridade de um item" },
  { name: "status", aliases: [], args: "", description: "Contagens, gasto de IA, limites e pausa" },
  { name: "pausar", aliases: ["pause"], args: "", description: "Pausa a geração de novos itens" },
  { name: "retomar", aliases: ["resume"], args: "", description: "Retoma a geração" },
  { name: "config", aliases: ["configs"], args: "", description: "Mostra as configurações que podem ser mudadas aqui" },
  { name: "definir", aliases: ["set"], args: "<chave> <valor>", description: "Muda uma configuração (ex.: /definir aprovacoes_dia 5)" },
  { name: "cancelar", aliases: ["cancel"], args: "", description: "Cancela a edição em andamento" },
  { name: "ajuda", aliases: ["help", "start"], args: "", description: "Lista os comandos" },
] as const;

export type CommandName = (typeof BOT_COMMANDS)[number]["name"];

export function resolveCommand(word: string): CommandName | undefined {
  const w = word.toLowerCase();
  return BOT_COMMANDS.find((c) => c.name === w || (c.aliases as readonly string[]).includes(w))?.name;
}

export const menuCommands = () => BOT_COMMANDS.map((c) => ({ command: c.name, description: c.description }));
