import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

/**
 * Tipo para estado do participante
 */
type ParticipantState = {
  samples: Array<{ ts: number; speech: boolean }>;
  ema: {
    arousal?: number;
    valence?: number;
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
 * Detecta arousal alto ou baixo.
 * 
 * Regras A2E2:
 * - Arousal alto (>= 0.5):
 *   - Se valence positivo → entusiasmo
 *   - Se valence negativo → estresse
 * - Arousal baixo (<= -0.2 ou <= -0.4):
 *   - Engajamento baixo
 * - Executa se não há emoções primárias OU se há emoções mas todas abaixo do threshold (0.05)
 * - Speech coverage >= 40% (estrito)
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se arousal anormal detectado, null caso contrário
 */
export function detectArousal(
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

  const ar = state.ema.arousal;
  if (typeof ar !== 'number') return null;

  const w = ctx.window(state, now, longWindowMs);
  // ETAPA 1: Mínimo ajustado de 15 para 8 amostras (janela de 10s, taxa ~1 amostra/s)
  // 8 amostras = 80% da janela esperada, garante dados suficientes para análise prosódica
  if (w.samplesCount < 8) return null;

  const speechCoverage = w.speechCount / w.samplesCount;
  if (speechCoverage < minSpeechProsodic) return null;

  const t = A2E2_THRESHOLDS.prosody.arousal;
  const val = state.ema.valence;

  // Arousal alto
  if (ar >= t.high) {
    // Determina tipo baseado em valence
    const isPositiveValence = typeof val === 'number' && val > 0;
    const type = isPositiveValence ? 'entusiasmo_alto' : 'tendencia_emocional_negativa';

    if (ctx.inCooldown(state, type, now)) return null;

    const severity: 'info' | 'warning' = ar >= t.highWarning ? 'warning' : 'info';
    const cooldownMs =
      severity === 'warning'
        ? A2E2_THRESHOLDS.cooldowns.prosodic.arousalWarning
        : A2E2_THRESHOLDS.cooldowns.prosodic.arousal;
    ctx.setCooldown(state, type, now, cooldownMs);

    const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;

    if (isPositiveValence) {
      // Entusiasmo
      return {
        id: ctx.makeId(),
        type: 'entusiasmo_alto',
        severity,
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message:
          severity === 'warning'
            ? `${name}: energia muito alta; canalize em próximos passos.`
            : `${name}: entusiasmo alto; ótimo momento para direcionar ações.`,
        tips: ['Direcione para decisões e próximos passos'],
        metadata: {
          arousalEMA: ar,
          valenceEMA: val,
          speechCoverage,
        },
      };
    } else {
      // Estresse (arousal alto + valence negativo)
      return {
        id: ctx.makeId(),
        type: 'tendencia_emocional_negativa',
        severity: 'warning',
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: `${name}: sinais de estresse (energia alta com tom negativo).`,
        tips: ['Reduza o ritmo', 'Valide objeções antes de avançar'],
        metadata: {
          arousalEMA: ar,
          valenceEMA: val,
          speechCoverage,
        },
      };
    }
  }

  // Arousal baixo
  if (ar <= t.low || ar <= t.lowInfo) {
    const type = 'engajamento_baixo';
    if (ctx.inCooldown(state, type, now)) return null;

    const warn = ar <= t.low;
    const cooldownMs = warn
      ? A2E2_THRESHOLDS.cooldowns.prosodic.arousalLowWarning
      : A2E2_THRESHOLDS.cooldowns.prosodic.arousal;
    ctx.setCooldown(state, type, now, cooldownMs);

    const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
    return {
      id: ctx.makeId(),
      type,
      severity: warn ? 'warning' : 'info',
      ts: now,
      meetingId,
      participantId,
      window: { start: w.start, end: w.end },
      message: warn
        ? `${name}: engajamento baixo (tom desanimado).`
        : `${name}: energia baixa. Um pouco mais de ênfase pode ajudar.`,
      tips: ['Fale com mais variação de tom', 'Projete a voz mais próxima do microfone'],
      metadata: {
        arousalEMA: ar,
        valenceEMA: val,
        speechCoverage,
      },
    };
  }

  return null;
}

