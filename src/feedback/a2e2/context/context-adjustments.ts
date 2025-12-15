/**
 * FASE 10.3.1: Ajustes de Threshold Dinâmicos Baseados em Contexto
 * 
 * Este módulo calcula ajustes de thresholds baseado em:
 * - Tensão emocional (arousal + valence)
 * - Padrões temporais (tendências)
 */

import { ParticipantState } from '../types';

/**
 * Nível de tensão emocional baseado em arousal e valence
 */
export type TensionLevel = 'high' | 'moderate' | 'low';

/**
 * Tendência de uma emoção ao longo do tempo
 */
export type EmotionTrend = 'increasing' | 'decreasing' | 'stable';

/**
 * Contexto para cálculo de ajustes de threshold
 */
export interface ThresholdAdjustmentContext {
  arousal?: number;
  valence?: number;
  emotionTrend?: EmotionTrend;
  tensionLevel?: TensionLevel;
}

/**
 * Calcula o nível de tensão emocional baseado em arousal e valence
 * 
 * FASE 10.3.1: Alta tensão = arousal alto + valence negativo
 * Baixa tensão = arousal baixo + valence positivo
 */
export function calculateTensionLevel(
  arousal?: number,
  valence?: number,
): TensionLevel {
  if (typeof arousal === 'number' && typeof valence === 'number') {
    // Alta tensão: arousal > 0.5 && valence < 0.0
    if (arousal > 0.5 && valence < 0.0) {
      return 'high';
    }
    // Baixa tensão: arousal < 0.2 && valence > 0.2
    if (arousal < 0.2 && valence > 0.2) {
      return 'low';
    }
  }
  return 'moderate';
}

/**
 * Calcula threshold dinâmico baseado em contexto
 * 
 * FASE 10.3.1:
 * - Alta tensão: reduz thresholds de emoções negativas críticas em 20%
 * - Baixa tensão: reduz thresholds de emoções positivas em 10-15%
 * - Tendência crescente: reduz threshold em 15% para detecção precoce
 * - Tendência decrescente: aumenta threshold em 10% para evitar falsos positivos
 * 
 * @param baseThreshold Threshold base da emoção
 * @param context Contexto emocional e temporal
 * @param emotionCategory Categoria da emoção ('negative' | 'positive' | 'neutral')
 * @returns Threshold ajustado
 */
export function getDynamicThreshold(
  baseThreshold: number,
  context: ThresholdAdjustmentContext,
  emotionCategory: 'negative' | 'positive' | 'neutral' = 'neutral',
): number {
  let adjustedThreshold = baseThreshold;
  const tensionLevel = context.tensionLevel || calculateTensionLevel(context.arousal, context.valence);

  // FASE 10.3.1: Ajuste por tensão emocional
  if (tensionLevel === 'high' && emotionCategory === 'negative') {
    // Alta tensão: reduz thresholds de emoções negativas críticas em 20%
    adjustedThreshold = baseThreshold * 0.8;
  } else if (tensionLevel === 'low' && emotionCategory === 'positive') {
    // Baixa tensão: reduz thresholds de emoções positivas em 10-15%
    // Engajamento: 10%, Serenidade/Conexão: 15%
    adjustedThreshold = baseThreshold * 0.9; // Padrão 10%, pode ser ajustado por detector
  }

  // FASE 10.3.1: Ajuste por tendência temporal
  if (context.emotionTrend === 'increasing' && emotionCategory === 'negative') {
    // Tendência crescente: reduz threshold em 15% para detecção precoce
    adjustedThreshold = Math.min(adjustedThreshold, baseThreshold * 0.85);
  } else if (context.emotionTrend === 'decreasing' && emotionCategory === 'negative') {
    // Tendência decrescente: aumenta threshold em 10% para evitar falsos positivos
    adjustedThreshold = Math.max(adjustedThreshold, baseThreshold * 1.1);
  }

  // Garante que o threshold ajustado não seja menor que 0.01 (mínimo absoluto)
  return Math.max(adjustedThreshold, 0.01);
}

/**
 * Calcula ajuste específico para hostilidade em alta tensão
 * 
 * FASE 10.3.1: Hostilidade em alta tensão reduz thresholds em 20%
 */
export function getHostilityThreshold(
  baseThreshold: number,
  tensionLevel: TensionLevel,
): number {
  if (tensionLevel === 'high') {
    return baseThreshold * 0.8; // Reduz 20%
  }
  return baseThreshold;
}

/**
 * Calcula ajuste específico para medo/ameaça em alta tensão
 * 
 * FASE 10.3.1: Medo/ameaça em alta tensão reduz thresholds em 15%
 */
export function getThreatThreshold(
  baseThreshold: number,
  tensionLevel: TensionLevel,
): number {
  if (tensionLevel === 'high') {
    return baseThreshold * 0.85; // Reduz 15%
  }
  return baseThreshold;
}

/**
 * Calcula ajuste específico para tristeza profunda em alta tensão
 * 
 * FASE 10.3.1: Tristeza profunda em alta tensão reduz thresholds em 10%
 */
export function getDeepSadnessThreshold(
  baseThreshold: number,
  tensionLevel: TensionLevel,
): number {
  if (tensionLevel === 'high') {
    return baseThreshold * 0.9; // Reduz 10%
  }
  return baseThreshold;
}

/**
 * Calcula ajuste específico para engajamento em baixa tensão
 * 
 * FASE 10.3.1: Engajamento em baixa tensão reduz thresholds em 10%
 */
export function getEngagementThreshold(
  baseThreshold: number,
  tensionLevel: TensionLevel,
): number {
  if (tensionLevel === 'low') {
    return baseThreshold * 0.9; // Reduz 10%
  }
  return baseThreshold;
}

/**
 * Calcula ajuste específico para serenidade em baixa tensão
 * 
 * FASE 10.3.1: Serenidade em baixa tensão reduz thresholds em 15%
 */
export function getSerenityThreshold(
  baseThreshold: number,
  tensionLevel: TensionLevel,
): number {
  if (tensionLevel === 'low') {
    return baseThreshold * 0.85; // Reduz 15%
  }
  return baseThreshold;
}

/**
 * Calcula ajuste específico para conexão em baixa tensão
 * 
 * FASE 10.3.1: Conexão em baixa tensão reduz thresholds em 10%
 */
export function getConnectionThreshold(
  baseThreshold: number,
  tensionLevel: TensionLevel,
): number {
  if (tensionLevel === 'low') {
    return baseThreshold * 0.9; // Reduz 10%
  }
  return baseThreshold;
}

/**
 * Calcula ajuste de threshold baseado em tendência temporal
 * 
 * FASE 10.3.1:
 * - Tendência crescente: reduz threshold em 15% para detecção precoce
 * - Tendência decrescente: aumenta threshold em 10% para evitar falsos positivos
 * 
 * @param baseThreshold Threshold base da emoção
 * @param emotionTrend Tendência da emoção ('increasing' | 'decreasing' | 'stable')
 * @param emotionCategory Categoria da emoção ('negative' | 'positive' | 'neutral')
 * @returns Threshold ajustado
 */
export function getThresholdByTrend(
  baseThreshold: number,
  emotionTrend: EmotionTrend,
  emotionCategory: 'negative' | 'positive' | 'neutral' = 'neutral',
): number {
  // Aplica apenas para emoções negativas críticas
  if (emotionCategory === 'negative') {
    if (emotionTrend === 'increasing') {
      // Tendência crescente: reduz threshold em 15% para detecção precoce
      return baseThreshold * 0.85;
    } else if (emotionTrend === 'decreasing') {
      // Tendência decrescente: aumenta threshold em 10% para evitar falsos positivos
      return baseThreshold * 1.1;
    }
  }
  return baseThreshold;
}

/**
 * Verifica se há tendência consistente (3+ detecções consecutivas)
 * 
 * FASE 10.3.1: Emoção aumentando consistentemente (3+ detecções consecutivas)
 * reduz threshold em 10% para detecção precoce
 * 
 * @param recentEmotions Lista de emoções recentes
 * @param emotionType Tipo de emoção a verificar
 * @param windowMs Janela temporal em milissegundos (padrão: 30s)
 * @param now Timestamp atual
 * @returns true se há 3+ detecções consecutivas na janela temporal
 */
export function hasConsistentTrend(
  recentEmotions: Array<{ type: string; ts: number }> | undefined,
  emotionType: string,
  windowMs: number = 30_000,
  now: number = Date.now(),
): boolean {
  if (!recentEmotions || recentEmotions.length < 3) {
    return false;
  }

  const cutoff = now - windowMs;
  const recentSameType = recentEmotions
    .filter((e) => e.type === emotionType && e.ts >= cutoff)
    .sort((a, b) => b.ts - a.ts); // Ordena por timestamp (mais recente primeiro)

  // Verifica se há 3+ detecções consecutivas (sem gaps grandes)
  if (recentSameType.length >= 3) {
    // Verifica se as 3 mais recentes estão próximas (dentro de 15s uma da outra)
    const mostRecent = recentSameType[0].ts;
    const secondRecent = recentSameType[1]?.ts;
    const thirdRecent = recentSameType[2]?.ts;

    if (secondRecent && thirdRecent) {
      const gap1 = mostRecent - secondRecent;
      const gap2 = secondRecent - thirdRecent;
      // Se os gaps são pequenos (< 15s), é uma tendência consistente
      return gap1 < 15_000 && gap2 < 15_000;
    }
  }

  return false;
}

/**
 * Verifica se há sobreposição recente de emoção similar
 * 
 * FASE 10.3.1: Emoção similar detectada nos últimos 20s
 * Bloqueia se score atual não é significativamente maior (> 20%)
 * 
 * @param recentEmotions Lista de emoções recentes
 * @param emotionType Tipo de emoção a verificar
 * @param currentScore Score atual da emoção
 * @param windowMs Janela temporal em milissegundos (padrão: 20s)
 * @param now Timestamp atual
 * @returns true se há sobreposição recente e score atual não é > 20% maior
 */
export function hasRecentOverlap(
  recentEmotions: Array<{ type: string; ts: number; score?: number }> | undefined,
  emotionType: string,
  currentScore: number,
  windowMs: number = 20_000,
  now: number = Date.now(),
): boolean {
  if (!recentEmotions || recentEmotions.length === 0) {
    return false;
  }

  const cutoff = now - windowMs;
  const recentSameType = recentEmotions
    .filter((e) => e.type === emotionType && e.ts >= cutoff)
    .sort((a, b) => b.ts - a.ts); // Ordena por timestamp (mais recente primeiro)

  if (recentSameType.length > 0) {
    // Pega o score mais recente (se disponível) ou assume um score padrão
    const mostRecentScore = recentSameType[0].score ?? currentScore * 0.8; // Assume 80% se não disponível
    
    // Bloqueia se score atual não é significativamente maior (> 20%)
    return currentScore <= mostRecentScore * 1.2;
  }

  return false;
}

/**
 * Calcula a tendência de uma emoção baseada no histórico de emoções
 * 
 * FASE 10.3.1: Calcula se emoção está aumentando (> 0.02 nos últimos 10s),
 * diminuindo (> 0.02 nos últimos 10s), ou estável
 * 
 * @param recentEmotions Lista de emoções recentes com scores
 * @param emotionName Nome da emoção a verificar
 * @param windowMs Janela temporal em milissegundos (padrão: 10s)
 * @param now Timestamp atual
 * @returns 'increasing' | 'decreasing' | 'stable'
 */
export function calculateEmotionTrend(
  recentEmotions: Array<{ type: string; ts: number; score?: number }> | undefined,
  emotionName: string,
  windowMs: number = 10_000,
  now: number = Date.now(),
): EmotionTrend {
  if (!recentEmotions || recentEmotions.length < 2) {
    return 'stable';
  }

  const cutoff = now - windowMs;
  const recentSameType = recentEmotions
    .filter((e) => e.type === emotionName && e.ts >= cutoff)
    .sort((a, b) => a.ts - b.ts); // Ordena por timestamp (mais antigo primeiro)

  if (recentSameType.length < 2) {
    return 'stable';
  }

  // Pega o score mais antigo e o mais recente
  const oldest = recentSameType[0].score ?? 0;
  const newest = recentSameType[recentSameType.length - 1].score ?? 0;

  const change = newest - oldest;

  // Tendência crescente: aumentou > 0.02
  if (change > 0.02) {
    return 'increasing';
  }
  // Tendência decrescente: diminuiu > 0.02
  if (change < -0.02) {
    return 'decreasing';
  }

  return 'stable';
}

