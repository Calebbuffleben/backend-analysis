import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';

/**
 * Detecta polarização emocional no grupo.
 * 
 * Regras A2E2 (RELAXADA):
 * - Grupos >= 1 pessoa com valence alto (>= threshold positivo) - detecta como "info"
 * - Grupos >= 2 pessoas com valence alto - detecta como "warning"
 * - Grupos >= 1 pessoa com valence baixo (<= threshold negativo) - detecta como "info"
 * - Grupos >= 2 pessoas com valence baixo - detecta como "warning"
 * - Diferença entre grupos >= threshold
 * - Mínimo de 3 participantes (excluindo host)
 * - Speech coverage >= threshold prosódico
 * 
 * Gradação de severidade:
 * - >= 1 pessoa em cada grupo: severity "info" (polarização leve)
 * - >= 2 pessoas em cada grupo: severity "warning" (polarização significativa)
 * 
 * @param state Não usado diretamente (usa todos os participantes)
 * @param ctx Contexto de detecção (meetingId, now, helpers)
 * @returns FeedbackEventPayload se polarização detectada, null caso contrário
 */
export function detectPolarization(
  state: unknown,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, now } = ctx;
  const participants = ctx.getParticipantsForMeeting?.(meetingId) ?? [];
  const t = A2E2_THRESHOLDS.metastates.polarization;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechMeta = A2E2_THRESHOLDS.gates.minSpeechMeta;

  if (participants.length < t.minParticipants) return null;

  const negVals: number[] = [];
  const posVals: number[] = [];

  // Agrupa participantes por valence
  for (const [pid, st] of participants) {
    // Ignora host
    const role = ctx.getParticipantRole?.(meetingId, pid);
    if (role === 'host') continue;

    // Verifica speech coverage
    const w = ctx.window(st, now, longWindowMs);
    if (w.samplesCount === 0) continue;
    const coverage = w.speechCount / w.samplesCount;
    if (coverage < minSpeechMeta) continue;

    // Obtém valence do EMA
    const v = st.ema.valence;
    if (typeof v !== 'number') continue;

    // Classifica em grupos positivo ou negativo
    if (v <= t.valenceNegative) {
      negVals.push(v);
    }
    if (v >= t.valencePositive) {
      posVals.push(v);
    }
  }

  // Relaxado: precisa ter pelo menos 1 pessoa em cada grupo (vs 2+ na versão anterior)
  if (negVals.length === 0 || posVals.length === 0) return null;

  // Calcula médias
  const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const negMean = mean(negVals);
  const posMean = mean(posVals);

  // Verifica se diferença é significativa
  if (posMean - negMean >= t.difference) {
    const type = 'polarizacao_emocional';
    if (ctx.inCooldownMeeting?.(meetingId, type, now)) return null;

    // Gradação baseada na diferença e no número de participantes
    const diff = posMean - negMean;
    const hasSignificantPolarization = negVals.length >= 2 && posVals.length >= 2;
    // Severidade 'warning' se diferença >= 0.5 E há >= 2 pessoas em cada grupo
    // Caso contrário, 'info'
    const severity: 'info' | 'warning' =
      diff >= 0.5 && hasSignificantPolarization ? 'warning' : 'info';

    ctx.setCooldownMeeting?.(meetingId, type, now, A2E2_THRESHOLDS.cooldowns.meta.polarization);

    return {
      id: ctx.makeId(),
      type,
      severity,
      ts: now,
      meetingId,
      participantId: 'group',
      window: { start: now - longWindowMs, end: now },
      message:
        severity === 'warning'
          ? `Polarização emocional no grupo (opiniões muito divergentes).`
          : `Polarização emocional leve detectada no grupo.`,
      tips: ['Reconheça pontos de ambos os lados', 'Estabeleça objetivos comuns antes de decidir'],
      metadata: {
        valenceEMA: Number(((posMean + negMean) / 2).toFixed(3)),
      },
    };
  }

  return null;
}

