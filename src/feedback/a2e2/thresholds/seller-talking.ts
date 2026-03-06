/**
 * Constantes e tipo do feedback "vendedor falando demais" (sales_seller_talking_too_much).
 * Sobrescritas via ENV: SALES_SELLER_TALKING_WINDOW_MS, MIN_TOTAL_MS, RATIO_THRESHOLD,
 * SEGMENT_DURATION_MS, COOLDOWN_MS.
 */

export const SALES_SELLER_TALKING_WINDOW_MS = 120_000;
export const SALES_SELLER_TALKING_MIN_TOTAL_MS = 30_000;
export const SALES_SELLER_TALKING_RATIO_THRESHOLD = 0.75;
export const SALES_SELLER_TALKING_SEGMENT_DURATION_MS = 7_000;
export const SALES_SELLER_TALKING_COOLDOWN_MS = 120_000;
export const FEEDBACK_TYPE_SELLER_TALKING = 'sales_seller_talking_too_much' as const;
