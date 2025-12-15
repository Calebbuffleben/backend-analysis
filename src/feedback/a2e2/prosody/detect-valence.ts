import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

/**
 * Tipo para estado do participante
 */
type ParticipantState = {
  samples: Array<{ ts: number; speech: boolean }>;
  ema: {
    valence?: number;
    arousal?: number;
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
  window: (state: ParticipantState, now: number, windowMs: number) => {
    start: number;
    end: number;
    samplesCount: number;
    speechCount: number;
  };
};

/**
 * Detecta valence negativo com diferenciação por arousal.
 * 
 * Regras A2E2:
 * - Valence negativo (<= -0.35 ou <= -0.6):
 *   - Se arousal alto → tensão
 *   - Se arousal baixo → desânimo
 * - Executa se não há emoções primárias OU se há emoções mas todas abaixo do threshold (0.05)
 * - Speech coverage >= 40% (estrito)
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se valence negativo detectado, null caso contrário
 */
export function detectValence(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  // Executa se não há emoções primárias OU se há emoções mas todas abaixo dos thresholds
  // ETAPA 4: Threshold de bloqueio ajustado de 0.05 para 0.07 para alinhar com thresholds primários
  // Isso elimina a "zona morta" onde emoções 0.05-0.07 bloqueavam prosódicos mas não eram detectadas como primárias
  const hasPrimaryEmotions = state.ema.emotions.size > 0;
  const hasSignificantPrimaryEmotions = Array.from(state.ema.emotions.values()).some(
    (v) => v > 0.07, // Threshold alinhado com thresholds primários (maioria das emoções = 0.07)
  );

  if (hasPrimaryEmotions && hasSignificantPrimaryEmotions) {
    return null; // Há emoções primárias significativas, não usar prosódicos
  }

  const { meetingId, participantId, now } = ctx;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechProsodic = A2E2_THRESHOLDS.gates.minSpeechProsodic;

  const val = state.ema.valence;
  if (typeof val !== 'number') return null;

  const w = ctx.window(state, now, longWindowMs);
  // ETAPA 1: Mínimo ajustado de 15 para 8 amostras (janela de 10s, taxa ~1 amostra/s)
  // 8 amostras = 80% da janela esperada, garante dados suficientes para análise prosódica
  if (w.samplesCount < 8) return null;

  const speechCoverage = w.speechCount / w.samplesCount;
  if (speechCoverage < minSpeechProsodic) return null;

  const t = A2E2_THRESHOLDS.prosody.valence;
  const ar = state.ema.arousal;

  // Valence negativo severo
  if (val <= t.negativeSevere) {
    const type = 'tendencia_emocional_negativa';
    if (ctx.inCooldown(state, type, now)) return null;

    // Diferencia por arousal
    const isHighArousal = typeof ar === 'number' && ar >= A2E2_THRESHOLDS.prosody.arousal.high;
    const isLowArousal = typeof ar === 'number' && ar <= A2E2_THRESHOLDS.prosody.arousal.lowInfo;

    ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.prosodic.valenceSevere);

    const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;

    if (isHighArousal) {
      // Tensão (valence negativo + arousal alto)
      return {
        id: ctx.makeId(),
        type,
        severity: 'warning',
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: `${name}: sinais de tensão (tom negativo com energia alta).`,
        tips: ['Reduza o ritmo', 'Valide objeções antes de avançar', 'Mostre concordância antes de divergir'],
        metadata: {
          valenceEMA: val,
          arousalEMA: ar,
          speechCoverage,
        },
      };
    } else if (isLowArousal) {
      // Desânimo (valence negativo + arousal baixo)
      return {
        id: ctx.makeId(),
        type,
        severity: 'warning',
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: `${name}: sinais de desânimo (tom negativo com energia baixa).`,
        tips: ['Mostre concordância antes de divergir', 'Evite frases muito secas', 'Fale com mais variação de tom'],
        metadata: {
          valenceEMA: val,
          arousalEMA: ar,
          speechCoverage,
        },
      };
    } else {
      // Valence negativo sem arousal extremo
      return {
        id: ctx.makeId(),
        type,
        severity: 'warning',
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: `${name}: tom negativo perceptível. Considere suavizar a comunicação.`,
        tips: ['Mostre concordância antes de divergir', 'Evite frases muito secas'],
        metadata: {
          valenceEMA: val,
          arousalEMA: ar,
          speechCoverage,
        },
      };
    }
  }

  // Valence negativo (info)
  if (val <= t.negativeInfo) {
    const type = 'tendencia_emocional_negativa';
    if (ctx.inCooldown(state, type, now)) return null;

    ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.prosodic.valence);

    const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
    return {
      id: ctx.makeId(),
      type,
      severity: 'info',
      ts: now,
      meetingId,
      participantId,
      window: { start: w.start, end: w.end },
      message: `${name}: tendência emocional negativa. Tente um tom mais positivo.`,
      tips: ['Mostre concordância antes de divergir', 'Evite frases muito secas'],
      metadata: {
        valenceEMA: val,
        arousalEMA: ar,
        speechCoverage,
      },
    };
  }

  return null;
}

