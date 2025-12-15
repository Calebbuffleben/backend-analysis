import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

/**
 * Tipo para amostra de dados do participante
 */
type Sample = {
  ts: number;
  speech: boolean;
  valence?: number;
  arousal?: number;
  rmsDbfs?: number;
  emotions?: Record<string, number>;
};

/**
 * Tipo para estado do participante
 */
type ParticipantState = {
  samples: Sample[];
  ema: {
    valence?: number;
    arousal?: number;
    rms?: number;
    emotions: Map<string, number>;
  };
  cooldownUntilByType: Map<string, number>;
  lastFeedbackAt?: number;
};

/**
 * Tipo para contexto de detecção
 */
type DetectionContext = {
  meetingId: string;
  participantId: string;
  now: number;
  getParticipantName: (meetingId: string, participantId: string) => string | undefined;
  inCooldown: (state: ParticipantState, type: string, now: number) => boolean;
  setCooldown: (state: ParticipantState, type: string, now: number, cooldownMs: number) => void;
  makeId: () => string;
};

/**
 * Detecta tendência de frustração crescente (FALLBACK).
 * 
 * Esta função funciona como FALLBACK quando não há emoções primárias detectadas.
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
 * - arousal aumentando (delta >= threshold) OU valence diminuindo (delta <= threshold)
 * - Severidade: 'warning' se ambos os sinais presentes, 'info' se apenas um
 * - speech coverage >= threshold
 * - Só executa se não há emoções primárias detectadas (fallback)
 * 
 * Nota: Ambos usam o mesmo type 'frustracao_crescente' para compartilhar cooldown.
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se frustração crescente detectada, null caso contrário
 */
export function detectFrustrationTrend(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  // ETAPA 6: FALLBACK ajustado - Executa se não há emoções primárias SIGNIFICATIVAS
  // (acima dos thresholds de detecção, não apenas acima de 0.05)
  // Isso permite detectar frustração moderada (0.05-0.07) via tendência quando não é detectada como primária
  const hasSignificantPrimaryEmotions = Array.from(state.ema.emotions.values()).some(
    (v) => v > 0.07, // Threshold alinhado com thresholds primários (maioria das emoções = 0.07)
  );
  if (hasSignificantPrimaryEmotions) return null; // Há emoções primárias significativas, usar primárias

  const { meetingId, participantId, now } = ctx;
  const t = A2E2_THRESHOLDS.metastates.frustrationTrend;
  const trendWindowMs = A2E2_THRESHOLDS.windows.trend;
  const minSpeechMeta = A2E2_THRESHOLDS.gates.minSpeechMeta;

  const start = now - trendWindowMs;
  let arousalEarlySum = 0;
  let arousalEarlyN = 0;
  let arousalLateSum = 0;
  let arousalLateN = 0;
  let valenceEarlySum = 0;
  let valenceEarlyN = 0;
  let valenceLateSum = 0;
  let valenceLateN = 0;
  let speechN = 0;

  // Divide a janela em duas metades (early e late)
  for (let i = state.samples.length - 1; i >= 0; i--) {
    const s = state.samples[i];
    if (s.ts < start) break;
    if (s.speech) speechN++;

    const isEarly = s.ts < now - trendWindowMs / 2;
    if (isEarly) {
      if (typeof s.arousal === 'number') {
        arousalEarlySum += s.arousal;
        arousalEarlyN++;
      }
      if (typeof s.valence === 'number') {
        valenceEarlySum += s.valence;
        valenceEarlyN++;
      }
    } else {
      if (typeof s.arousal === 'number') {
        arousalLateSum += s.arousal;
        arousalLateN++;
      }
      if (typeof s.valence === 'number') {
        valenceLateSum += s.valence;
        valenceLateN++;
      }
    }
  }

  const totalN = arousalEarlyN + arousalLateN + valenceEarlyN + valenceLateN;
  // ETAPA 1: Mínimos ajustados (speechN: 10→8, totalN: 15→12)
  // Janela de 20s, taxa ~1 amostra/s: 8 amostras de speech = 40% da janela esperada
  // 12 amostras totais de arousal/valence = 60% da janela esperada
  if (speechN < 8 || totalN < 12) return null;

  // Calcula médias para cada metade
  const arousalEarly = arousalEarlyN > 0 ? arousalEarlySum / arousalEarlyN : undefined;
  const arousalLate = arousalLateN > 0 ? arousalLateSum / arousalLateN : undefined;
  const valenceEarly = valenceEarlyN > 0 ? valenceEarlySum / valenceEarlyN : undefined;
  const valenceLate = valenceLateN > 0 ? valenceLateSum / valenceLateN : undefined;

  if (typeof arousalEarly !== 'number' || typeof arousalLate !== 'number') return null;
  if (typeof valenceEarly !== 'number' || typeof valenceLate !== 'number') return null;

  // Calcula deltas
  const arousalDelta = arousalLate - arousalEarly;
  const valenceDelta = valenceLate - valenceEarly;

  // Verifica speech coverage
  const totalSamples = state.samples.filter((s) => s.ts >= start).length;
  const speechCoverage = totalSamples > 0 ? speechN / totalSamples : 0;
  if (speechCoverage < minSpeechMeta) return null;

  // Verifica thresholds - aceita OU em vez de E
  const hasArousalIncrease = arousalDelta >= t.arousalDelta;
  const hasValenceDecrease = valenceDelta <= t.valenceDelta;

  if (hasArousalIncrease || hasValenceDecrease) {
    const type = 'frustracao_crescente';
    if (ctx.inCooldown(state, type, now)) return null;

    // Severidade baseada em quantos sinais estão presentes
    const severity: 'info' | 'warning' =
      hasArousalIncrease && hasValenceDecrease ? 'warning' : 'info';

    ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.meta.frustrationTrend);

    const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
    return {
      id: ctx.makeId(),
      type,
      severity,
      ts: now,
      meetingId,
      participantId,
      window: { start, end: now },
      message:
        severity === 'warning'
          ? `${name}: indícios de frustração crescente.`
          : `${name}: possível frustração (${hasArousalIncrease ? 'energia aumentando' : 'tom diminuindo'}).`,
      tips: ['Reduza o ritmo e cheque entendimento', 'Valide objeções antes de avançar'],
      metadata: {
        arousalEMA: state.ema.arousal,
        valenceEMA: state.ema.valence,
        speechCoverage,
      },
    };
  }

  return null;
}

