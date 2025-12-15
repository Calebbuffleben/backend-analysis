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
    arousal?: number;
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
 * Detecta silêncio prolongado.
 * 
 * Regras A2E2:
 * - Speech coverage < 5% na janela de 60s
 * - Detecta silêncio em dois cenários:
 *   1. Microfone desconectado: RMS abaixo do threshold (-50 dBFS)
 *   2. Silêncio real: RMS normal mas speech coverage baixo E arousal baixo (< 0.0)
 * - Ignora se arousal alto (pausa normal, não silêncio problemático)
 * - Requer que participante tenha falado antes
 * - Mínimo de 10 amostras
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se silêncio prolongado detectado, null caso contrário
 */
export function detectSilence(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const t = A2E2_THRESHOLDS.longterm.silence;

  const window = ctx.window(state, now, t.windowMs);
  if (window.samplesCount < t.minSamples) return null;

  const speechCoverage = window.speechCount / window.samplesCount;
  if (speechCoverage >= t.speechCoverage) return null;

  // Requer que participante tenha falado antes (não é novo participante)
  const hasSpokenBefore = state.samples.some((s) => s.speech);
  if (!hasSpokenBefore) return null;

  // Ignora se arousal alto (pausa normal, não silêncio problemático)
  const arousal = state.ema.arousal;
  if (typeof arousal === 'number' && arousal >= A2E2_THRESHOLDS.prosody.arousal.high) {
    return null;
  }

  // Verifica RMS (microfone pode estar desconectado OU participante está em silêncio)
  const rms = window.meanRmsDbfs;
  const isMicPossiblyMuted = typeof rms !== 'number' || rms <= t.rmsThreshold;
  const isSilenceWithWorkingMic = typeof rms === 'number' && rms > t.rmsThreshold;

  // ETAPA 7: Detectar silêncio se:
  // 1. Microfone desconectado (RMS muito baixo), OU
  // 2. Silêncio real com microfone funcionando (RMS normal mas speech coverage baixo E arousal baixo/neutro)
  if (!isMicPossiblyMuted && !(isSilenceWithWorkingMic && typeof arousal === 'number' && arousal < 0.2)) {
    return null;
  }

  const type = 'silencio_prolongado';
  if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) return null;

  ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.longTerm.silence);

  const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
  const coveragePercent = (speechCoverage * 100).toFixed(1);
  const rmsFormatted = typeof rms === 'number' ? rms.toFixed(1) : 'N/A';

  // ETAPA 7: Gradação de severidade baseada em arousal
  // arousal < 0.0 = warning (silêncio preocupante), arousal 0.0-0.2 = info (silêncio neutro)
  let severity: 'info' | 'warning' = 'warning';
  let message: string;
  let tips: string[];

  if (isMicPossiblyMuted) {
    message = `${name}: sem áudio há ${t.windowMs / 1000}s (${coveragePercent}% de fala, ${rmsFormatted} dBFS); microfone pode estar desconectado.`;
    tips = [
      'Verifique se o microfone está conectado',
      'Cheque as permissões de áudio',
      'Teste o microfone nas configurações do sistema',
    ];
    severity = 'warning'; // Microfone desconectado é sempre warning
  } else if (isSilenceWithWorkingMic && typeof arousal === 'number') {
    severity = arousal < 0.0 ? 'warning' : 'info';
    message =
      severity === 'warning'
        ? `${name}: silêncio prolongado e energia baixa. Considere convidar à participação.`
        : `${name}: silêncio prolongado detectado. Considere convidar à participação.`;
    tips = [
      'Faça uma pergunta direta',
      'Convide a pessoa a compartilhar sua opinião',
      'Mude o tópico brevemente para reengajar',
    ];
  } else {
    return null; // Não deveria chegar aqui, mas por segurança
  }

  return {
    id: ctx.makeId(),
    type,
    severity,
    ts: now,
    meetingId,
    participantId,
    window: { start: window.start, end: window.end },
    message,
    tips,
    metadata: {
      speechCoverage,
      rmsDbfs: rms,
      arousalEMA: arousal,
    },
  };
}

