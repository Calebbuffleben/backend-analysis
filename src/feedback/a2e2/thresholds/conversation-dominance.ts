/**
 * Constantes do feedback "dominância de conversa" (conversation_dominance).
 * Todos os valores são pré-definidos aqui; o feedback não depende de variáveis de ambiente.
 * ENV serve apenas como override opcional (CONVERSATION_DOMINANCE_*).
 */

/** Habilitar o detector (default: true). Override: CONVERSATION_DOMINANCE_ENABLED */
export const CONVERSATION_DOMINANCE_ENABLED_DEFAULT = true;

export const CONVERSATION_DOMINANCE_WINDOW_MS = 120_000;
export const CONVERSATION_DOMINANCE_MIN_TOTAL_MS = 30_000;
export const CONVERSATION_DOMINANCE_RATIO_THRESHOLD = 0.75;
export const CONVERSATION_DOMINANCE_SEGMENT_DURATION_MS = 7_000;
export const CONVERSATION_DOMINANCE_COOLDOWN_MS = 120_000;
export const FEEDBACK_TYPE_CONVERSATION_DOMINANCE = 'conversation_dominance' as const;
