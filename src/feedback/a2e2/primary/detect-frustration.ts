import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';
import { getThresholdByTrend, hasConsistentTrend, hasRecentOverlap, calculateEmotionTrend } from '../context/context-adjustments';

/**
 * Detecta frustração através de emoção primária (PRIMARY).
 * 
 * Esta é a detecção primária de frustração. Se não houver emoções primárias,
 * o sistema usa detectFrustrationTrend() como fallback.
 * 
 * Hierarquia de detecção de frustração:
 * 1. PRIMARY: detectFrustration() - detecta frustração direta via emoção primária
 *    - Só executa se state.ema.emotions.size > 0
 *    - Detecta quando frustration > 0.05
 * 2. FALLBACK: detectFrustrationTrend() - detecta frustração via tendência prosódica
 *    - Só executa se state.ema.emotions.size === 0 (sem emoções primárias)
 *    - Detecta quando arousal aumenta E valence diminui
 * 
 * Regras A2E2:
 * - Detecta frustration acima do threshold (0.05)
 * - Requer speech coverage >= 20%
 * - Cooldown de 25s
 * - Só executa se há emoções primárias detectadas
 * - FASE 10.3.1: Bloqueio por oscilação rápida
 * 
 * Nota: Ambos usam o mesmo type 'frustracao_crescente' para compartilhar cooldown.
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se frustração detectada, null caso contrário
 */
export function detectFrustration(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechPrimary = A2E2_THRESHOLDS.gates.minSpeechPrimary;

  // FASE 10.3.1: Bloqueio por oscilação rápida
  // Se frustração foi detectada 3+ vezes nos últimos 30s, bloqueia para evitar spam
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    const recentFrustrationCount = recentEmotions.filter((e: { type: string; ts: number }) => e.type === 'frustracao_crescente').length;
    if (recentFrustrationCount >= 3) {
      return null; // Oscilação rápida detectada, bloqueia para evitar spam
    }
  }

  // Validações básicas
  const w = ctx.window(state, now, longWindowMs);
  // ETAPA 1: Mínimo ajustado de 10 para 6 amostras (janela de 10s, taxa ~1 amostra/s)
  // 6 amostras = 60% da janela esperada, permite detecção precoce de emoções primárias
  if (w.samplesCount < 6) return null;
  if (state.ema.emotions.size === 0) return null;

  // Verifica speech coverage
  const speechCoverage = w.samplesCount > 0 ? w.speechCount / w.samplesCount : 0;
  if (speechCoverage < minSpeechPrimary) return null;

  // Obtém valor de frustração
  const frustration = state.ema.emotions.get('frustration') ?? 0;
  const t = A2E2_THRESHOLDS.primary.frustration;
  
  // FASE 10.3.1: Calcula tendência temporal e ajusta threshold
  const getEmotionTrendValue = (): 'increasing' | 'decreasing' | 'stable' => {
    if (ctx.getEmotionTrend) {
      return ctx.getEmotionTrend(state, 'frustration', 10_000, now);
    }
    // Fallback: calcula tendência baseada no histórico de emoções
    if (ctx.getRecentEmotions) {
      const recentEmotions = ctx.getRecentEmotions(state, 10_000, now);
      return calculateEmotionTrend(recentEmotions, 'frustration', 10_000, now);
    }
    return 'stable';
  };
  
  const tAdjusted = getThresholdByTrend(t.frustration, getEmotionTrendValue(), 'negative');
  
  // FASE 10.3.1: Validação por tendência consistente
  // Se frustração está aumentando consistentemente (3+ detecções consecutivas), reduz threshold adicional
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    
    // FASE 10.3.1: Bloqueio por sobreposição recente
    // Se frustração similar foi detectada nos últimos 20s e score atual não é > 20% maior, bloqueia
    if (hasRecentOverlap(recentEmotions, 'frustracao_crescente', frustration, 20_000, now)) {
      return null; // Sobreposição recente detectada, bloqueia para evitar spam
    }
    
    if (hasConsistentTrend(recentEmotions, 'frustracao_crescente', 30_000, now)) {
      // Aplica redução adicional de 10% para detecção precoce
      const tAdjustedWithTrend = tAdjusted * 0.9;
      if (frustration <= tAdjustedWithTrend) return null;
    } else {
      if (frustration <= tAdjusted) return null;
    }
  } else {
    if (frustration <= tAdjusted) return null;
  }

  // Verifica cooldowns
  const type = 'frustracao_crescente';
  if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) {
    return null;
  }

  // Define cooldown
  ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.primaryEmotion.frustration);

  // Gera feedback
  const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
  return {
    id: ctx.makeId(),
    type,
    severity: 'warning',
    ts: now,
    meetingId,
    participantId,
    window: { start: w.start, end: w.end },
    message: `${name}: parece haver um bloqueio ou frustração.`,
    tips: ['Reconheça a dificuldade', 'Pergunte: "O que está impedindo nosso progresso?"'],
    metadata: {
      valenceEMA: state.ema.valence,
      speechCoverage,
    },
  };
}
