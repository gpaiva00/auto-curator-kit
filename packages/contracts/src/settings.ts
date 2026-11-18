/**
 * The profile settings that can be changed from Telegram (/config, /definir). Whitelist on purpose: secrets (.env)
 * never go through the chat, and only these profile.json fields are writable.
 */
export interface SettingDef {
  /** What the user types after /definir. */
  key: string;
  /** Dotted path inside profile.json. */
  path: string;
  label: string;
  kind: "int" | "number" | "text";
  min?: number;
  max?: number;
}

export const SETTINGS: readonly SettingDef[] = [
  { key: "aprovacoes_dia", path: "pipeline.dailyApprovalCap", label: "Apresentados por dia no Telegram", kind: "int", min: 1 },
  { key: "fila_maxima", path: "pipeline.maxPendingApproval", label: "Aguardando aprovação antes de gerar mais", kind: "int", min: 1 },
  { key: "triagem_minima", path: "pipeline.triageMinScore", label: "Nota mínima na triagem (0–100)", kind: "number", min: 0, max: 100 },
  { key: "confianca_minima", path: "editorial.minConfidence", label: "Confiança mínima do curador (0–1)", kind: "number", min: 0, max: 1 },
  { key: "idade_maxima_horas", path: "pipeline.maxItemAgeHours", label: "Idade máxima do item (horas)", kind: "number", min: 0.1 },
  { key: "fuso", path: "timezone", label: "Fuso horário", kind: "text" },
  { key: "idioma", path: "language", label: "Idioma", kind: "text" },
];

/** A setting with its current value, as shown by /config. */
export interface SettingView extends SettingDef {
  value: string | number;
}
