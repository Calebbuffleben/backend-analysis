import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

/**
 * Tipo para amostra de dados do participante
 */
type Sample = {
  ts: number;
  speech: boolean;
  rmsDbfs?: number;
};

/**
 * Tipo para estado do participante
 */
type ParticipantState = {
  samples: Sample[];
  ema: {
    rms?: number;
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
  inGlobalCooldown: (state: ParticipantState, now: number) => boolean;
  setCooldown: (state: ParticipantState, type: string, now: number, cooldownMs: number) => void;
  makeId: () => string;
  window: (state: ParticipantState, now: number, windowMs: number) => {
    start: number;
    end: number;
    samplesCount: number;
    speechCount: number;
    meanRmsDbfs?: number;
  };
};

/**
 * Detecta volume alto ou baixo.
 * 
 * Regras A2E2:
 * - Volume baixo: <= -28 dBFS (warning), <= -34 dBFS (critical)
 * - Volume alto: >= -10 dBFS (warning), >= -6 dBFS (critical)
 * - Speech coverage >= 50%
 * - Mensagens incluem valores quantitativos em dB
 * - Detecta conflitos (volume alto e baixo simultaneamente)
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se volume anormal detectado, null caso contrário
 */
export function detectVolume(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const shortWindowMs = A2E2_THRESHOLDS.windows.short;
  const minSpeechProsodicVolume = A2E2_THRESHOLDS.gates.minSpeechProsodicVolume;

  const w = ctx.window(state, now, shortWindowMs);
  // ETAPA 1: Mínimo ajustado de 15 para 5 amostras (janela de 5s, taxa ~1 amostra/s)
  // 5 amostras = 50% da janela esperada, realista para detecção de volume
  if (w.samplesCount < 5) return null;

  const speechCoverage = w.speechCount / w.samplesCount;
  if (speechCoverage < minSpeechProsodicVolume) return null;

  // Usa média da janela ou EMA como fallback
  const mean = w.meanRmsDbfs;
  const ema = state.ema.rms;
  const level = typeof mean === 'number' ? mean : typeof ema === 'number' ? ema : undefined;
  if (typeof level !== 'number') return null;

  const t = A2E2_THRESHOLDS.prosody.volume;
  const isLow = level <= t.low;
  const isHigh = level >= t.high;

  // Conflito: volume alto e baixo simultaneamente (impossível)
  if (isLow && isHigh) return null;

  // Verificação contextual: Volume muito baixo com arousal alto pode indicar problema técnico,
  // não emocional. Nesse caso, priorizamos o feedback de volume (mais acionável).
  // Mas se volume está apenas um pouco baixo e arousal está extremamente alto,
  // pode ser que a pessoa esteja falando com energia mas o microfone está longe.
  // Por enquanto, não bloqueamos - volume baixo é sempre um problema técnico a ser resolvido.

  if (isLow) {
    const type = 'volume_baixo';
    if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) return null;

    const severity = level <= t.lowCritical ? 'critical' : 'warning';
    ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.prosodic.volume);

    const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
    const levelFormatted = level.toFixed(1);
    return {
      id: ctx.makeId(),
      type,
      severity,
      ts: now,
      meetingId,
      participantId,
      window: { start: w.start, end: w.end },
      message:
        severity === 'critical'
          ? `${name}: quase inaudível (${levelFormatted} dBFS); aumente o ganho imediatamente.`
          : `${name}: volume baixo (${levelFormatted} dBFS); aproxime-se do microfone.`,
      tips:
        severity === 'critical'
          ? ['Aumente o ganho de entrada', 'Aproxime-se do microfone']
          : ['Verifique entrada de áudio', 'Desative redução agressiva de ruído'],
      metadata: {
        rmsDbfs: level,
        speechCoverage,
      },
    };
  }

  if (isHigh) {
    const type = 'volume_alto';
    if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) return null;

    const severity = level >= t.highCritical ? 'critical' : 'warning';
    ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.prosodic.volume);

    const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
    const levelFormatted = level.toFixed(1);
    return {
      id: ctx.makeId(),
      type,
      severity,
      ts: now,
      meetingId,
      participantId,
      window: { start: w.start, end: w.end },
      message:
        severity === 'critical'
          ? `${name}: áudio clipando (${levelFormatted} dBFS); reduza o ganho.`
          : `${name}: volume alto (${levelFormatted} dBFS); afaste-se um pouco.`,
      tips: ['Reduza sensibilidade do microfone'],
      metadata: {
        rmsDbfs: level,
        speechCoverage,
      },
    };
  }

  return null;
}

