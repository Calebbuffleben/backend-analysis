import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

/**
 * Tipo para amostra de dados do participante
 */
type Sample = {
  ts: number;
  speech: boolean;
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
  inGlobalCooldown: (state: ParticipantState, now: number) => boolean;
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
 * Detecta ritmo acelerado ou pausado.
 * 
 * Regras A2E2:
 * - Ritmo acelerado:
 *   - switchesPerSec >= 1.0 e speechSegments >= 6
 *   - warning se switchesPerSec >= 1.5
 * - Ritmo pausado:
 *   - longestSilence >= 5.0s e speechCoverage < 0.10
 *   - warning se longestSilence >= 7.0s
 * - Detecta conflitos (acelerado e pausado simultaneamente)
 * - Requer que participante tenha falado antes
 * 
 * @param state Estado do participante com samples
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se ritmo anormal detectado, null caso contrário
 */
export function detectPace(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;

  const start = now - longWindowMs;
  const samples = state.samples.filter((s) => s.ts >= start);
  // ETAPA 1: Mínimo ajustado de 15 para 8 amostras (janela de 10s, taxa ~1 amostra/s)
  // 8 amostras = 80% da janela esperada, garante dados suficientes para análise de ritmo
  if (samples.length < 8) return null;

  // Verifica se participante já falou antes
  const hasSpokenBefore = state.samples.some((s) => s.speech);
  if (!hasSpokenBefore) return null;

  // Analisa alternâncias fala/silêncio
  let switches = 0;
  let speechSegments = 0;
  let longestSilence = 0;
  let currentIsSpeech: boolean | undefined = undefined;
  let currentStart = start;
  let lastTs = start;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const segDur = (s.ts - lastTs) / 1000;

    // Atualiza longestSilence durante silêncio
    if (typeof currentIsSpeech === 'boolean' && !currentIsSpeech) {
      if (segDur > longestSilence) longestSilence = segDur;
    }

    // Inicializa estado
    if (typeof currentIsSpeech !== 'boolean') {
      currentIsSpeech = s.speech;
      currentStart = s.ts;
      lastTs = s.ts;
      continue;
    }

    // Detecta mudança de estado (fala ↔ silêncio)
    if (s.speech !== currentIsSpeech) {
      switches++;
      const dur = (s.ts - currentStart) / 1000;

      if (currentIsSpeech) {
        speechSegments++;
      } else {
        // Atualiza longestSilence ao sair de silêncio
        if (dur > longestSilence) longestSilence = dur;
      }

      currentIsSpeech = s.speech;
      currentStart = s.ts;
    }

    lastTs = s.ts;
  }

  // Processa segmento final
  const tailDur = (now - currentStart) / 1000;
  if (currentIsSpeech) {
    speechSegments++;
  } else {
    if (tailDur > longestSilence) longestSilence = tailDur;
  }

  // Calcula métricas
  const windowSec = longWindowMs / 1000;
  const switchesPerSec = switches / windowSec;
  const w = ctx.window(state, now, longWindowMs);
  const speechCoverage = w.samplesCount > 0 ? w.speechCount / w.samplesCount : 0;

  const tAccel = A2E2_THRESHOLDS.prosody.pace.accelerated;
  const tPaused = A2E2_THRESHOLDS.prosody.pace.paused;

  const isAccelerated =
    switchesPerSec >= tAccel.switchesPerSec && speechSegments >= tAccel.minSegments;
  const isPaused = longestSilence >= tPaused.longestSilence && speechCoverage < tPaused.minCoverage;

  // Conflito: ritmo acelerado e pausado simultaneamente (ignorar ambos)
  if (isAccelerated && isPaused) return null;

  // Verificação contextual: Evita contradições com arousal
  const arousalEMA = state.ema.arousal;
  if (typeof arousalEMA === 'number') {
    const arousalHigh = A2E2_THRESHOLDS.prosody.arousal.high;
    const arousalLow = A2E2_THRESHOLDS.prosody.arousal.low;

    // Ritmo acelerado com arousal muito baixo é contraditório
    // (ritmo acelerado geralmente indica energia/arousal alto)
    if (isAccelerated && arousalEMA <= arousalLow) {
      return null;
    }

    // Ritmo pausado com arousal alto pode ser normal (pausa pensativa durante entusiasmo)
    // Bloqueia detecção de ritmo pausado se arousal está alto para evitar conflito
    if (isPaused && arousalEMA >= arousalHigh) {
      return null; // Pausas durante entusiasmo são normais
    }
  }

  // Ritmo acelerado
  if (isAccelerated) {
    const type = 'ritmo_acelerado';
    if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) return null;

    const severity: 'info' | 'warning' =
      switchesPerSec >= tAccel.warningThreshold ? 'warning' : 'info';
    ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.prosodic.rhythmAccelerated);

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
          ? `${name}: ritmo acelerado; desacelere para melhor entendimento.`
          : `${name}: ritmo rápido; considere pausas curtas.`,
      tips: ['Faça pausas para respiração', 'Enuncie com clareza'],
      metadata: {
        speechCoverage,
      },
    };
  }

  // Ritmo pausado
  if (isPaused) {
    const type = 'ritmo_pausado';
    if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) return null;

    const severity: 'info' | 'warning' =
      longestSilence >= tPaused.warningThreshold ? 'warning' : 'info';
    ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.prosodic.rhythmPaused);

    const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
    const silenceFormatted = longestSilence.toFixed(1);
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
          ? `${name}: pausas muito longas (≥${silenceFormatted}s); tente manter um ritmo mais constante.`
          : `${name}: ritmo lento; considere reduzir pausas longas.`,
      tips: ['Reduza pausas longas', 'Mantenha frases mais curtas'],
      metadata: {
        speechCoverage,
      },
    };
  }

  return null;
}

