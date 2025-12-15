import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';

/**
 * Detecta overlap de fala (múltiplas vozes simultâneas).
 * 
 * Regras A2E2:
 * - Múltiplos participantes falando simultaneamente
 * - Speech coverage >= 20% para cada participante
 * - Mínimo de 2 participantes falando ao mesmo tempo
 * - Identifica participantes envolvidos no overlap
 * 
 * @param state Estado do participante atual (usado para identificar target)
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se overlap detectado, null caso contrário
 */
export function detectOverlap(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const participants = ctx.getParticipantsForMeeting?.(meetingId) ?? [];
  const t = A2E2_THRESHOLDS.longterm.overlap;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;

  if (participants.length < t.minParticipants) return null;

  // Identifica participantes falando simultaneamente
  const speaking: Array<{ id: string; coverage: number; state: ParticipantState }> = [];

  for (const [pid, st] of participants) {
    const w = ctx.window(st, now, longWindowMs);
    if (w.samplesCount === 0) continue;

    const coverage = w.speechCount / w.samplesCount;
    if (coverage >= t.minCoverage) {
      speaking.push({ id: pid, coverage, state: st });
    }
  }

  // Verifica se há overlap (múltiplos participantes falando)
  if (speaking.length >= t.minParticipants) {
    // Prioriza o participante atual, senão escolhe o com maior coverage
    const target =
      speaking.find((s) => s.id === participantId) ??
      speaking.sort((a, b) => b.coverage - a.coverage)[0];

    const type = 'overlap_fala';
    if (ctx.inCooldown(target.state, type, now)) return null;

    ctx.setCooldown(target.state, type, now, A2E2_THRESHOLDS.cooldowns.longTerm.overlap);

    const name = ctx.getParticipantName(meetingId, target.id) ?? target.id;

    // Identifica outros participantes envolvidos
    const others = speaking
      .filter((s) => s.id !== target.id)
      .map((s) => ctx.getParticipantName(meetingId, s.id) ?? s.id)
      .slice(0, 2); // Limita a 2 para não poluir a mensagem

    const othersText = others.length > 0 ? ` (com ${others.join(' e ')})` : '';
    const coveragePercent = (target.coverage * 100).toFixed(1);

    return {
      id: ctx.makeId(),
      type,
      severity: 'warning',
      ts: now,
      meetingId,
      participantId: target.id,
      window: { start: now - longWindowMs, end: now },
      message: `${name}${othersText} falando ao mesmo tempo com frequência (${coveragePercent}% de fala).`,
      tips: [
        'Combine turnos de fala',
        'Use levantar a mão antes de falar',
        'Aguarde a pessoa terminar antes de começar',
      ],
      metadata: {
        speechCoverage: target.coverage,
      },
    };
  }

  return null;
}

