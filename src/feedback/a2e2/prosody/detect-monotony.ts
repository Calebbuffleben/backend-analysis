import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

/**
 * Tipo para amostra de dados do participante
 */
type Sample = {
  ts: number;
  speech: boolean;
  arousal?: number;
};

/**
 * Tipo para estado do participante
 */
type ParticipantState = {
  samples: Sample[];
  ema: {
    arousal?: number;
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
 * Detecta monotonia prosódica (falta de variação na entonação).
 * 
 * Regras A2E2:
 * - Calcula desvio padrão do arousal na janela longa
 * - stdev < 0.1 (info) ou < 0.06 (warning) indica monotonia
 * - Speech coverage >= 0.4 (40%)
 * - Mínimo de 5 amostras de speech e 5 valores de arousal
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se monotonia detectada, null caso contrário
 */
export function detectMonotony(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechProsodic = A2E2_THRESHOLDS.gates.minSpeechProsodic;

  const start = now - longWindowMs;
  const values: number[] = [];
  let speechN = 0;

  // Coleta valores de arousal e conta speech
  for (let i = state.samples.length - 1; i >= 0; i--) {
    const s = state.samples[i];
    if (s.ts < start) break;
    if (s.speech) speechN++;
    if (typeof s.arousal === 'number') {
      values.push(s.arousal);
    }
  }

  // Validações mínimas
  // ETAPA 1: Mínimos ajustados de 15 para 8 amostras (janela de 10s, taxa ~1 amostra/s)
  // 8 amostras = 80% da janela esperada, garante dados suficientes para análise prosódica
  if (speechN < 8 || values.length < 8) return null;

  // Calcula speech coverage
  const totalSamples = state.samples.filter((s) => s.ts >= start).length;
  const speechCoverage = totalSamples > 0 ? speechN / totalSamples : 0;
  if (speechCoverage < minSpeechProsodic) return null;

  // Calcula desvio padrão
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  const stdev = Math.sqrt(variance);

  // Verificação contextual: Se arousal está muito alto ou muito baixo,
  // pode não ser monotonia real, mas sim entusiasmo constante ou desânimo constante.
  // Nesses casos, é melhor detectar como arousal alto/baixo, não monotonia.
  const arousalEMA = state.ema.arousal;
  if (typeof arousalEMA === 'number') {
    // Bloquear monotonia se arousal está extremo (mais sensível)
    // Usa thresholds mais baixos (0.4 e -0.2) em vez dos extremos (0.5 e -0.4)
    // para prevenir conflitos entre monotonia e arousal alto/baixo
    if (arousalEMA >= 0.4 || arousalEMA <= -0.2) {
      return null;
    }
  }

  const t = A2E2_THRESHOLDS.prosody.monotony;
  if (stdev < t.stdevInfo) {
    const type = 'monotonia_prosodica';
    if (ctx.inCooldown(state, type, now)) return null;

    const severity: 'info' | 'warning' = stdev < t.stdevWarning ? 'warning' : 'info';
    ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.prosodic.monotony);

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
          ? `${name}: fala monótona; varie entonação e pausas.`
          : `${name}: pouca variação de entonação.`,
      tips: ['Use pausas e ênfases para destacar pontos'],
      metadata: {
        arousalEMA: state.ema.arousal,
        speechCoverage,
      },
    };
  }

  return null;
}

