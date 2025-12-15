import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';

/**
 * Detecta energia baixa do grupo.
 * 
 * Regras A2E2:
 * - Calcula arousal médio de todos os participantes (exceto host)
 * - Verifica se arousal médio <= -0.3 (info) ou <= -0.5 (warning)
 * - Requer speech coverage >= 30% para cada participante
 * - Cooldown de reunião (não de participante)
 * - Feedback de grupo (participantId: 'group')
 * 
 * @param state Não usado diretamente (usa todos os participantes)
 * @param ctx Contexto de detecção (meetingId, now, helpers)
 * @returns FeedbackEventPayload se energia baixa detectada, null caso contrário
 */
export function detectGroupEnergy(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, now } = ctx;
  const participants = ctx.getParticipantsForMeeting?.(meetingId) ?? [];
  if (participants.length === 0) return null;

  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechMeta = A2E2_THRESHOLDS.gates.minSpeechMeta;

  // Calcula arousal médio de todos os participantes (exceto host)
  let sum = 0;
  let n = 0;

  for (const [pid, st] of participants) {
    const role = ctx.getParticipantRole?.(meetingId, pid);
    if (role === 'host') continue;

    const w = ctx.window(st, now, longWindowMs);
    if (w.samplesCount === 0) continue;

    const coverage = w.speechCount / w.samplesCount;
    if (coverage < minSpeechMeta) continue;

    if (typeof st.ema.arousal === 'number') {
      sum += st.ema.arousal;
      n++;
    }
  }

  if (n === 0) return null;

  const mean = sum / n;
  const t = A2E2_THRESHOLDS.prosody.groupEnergy;

  // Verifica se energia está baixa
  if (mean > t.low) return null;

  // Verifica cooldown de reunião
      const type = 'energia_grupo_baixa';
      if (ctx.inCooldownMeeting?.(meetingId, type, now)) return null;

  // Define cooldown de reunião
      const severity: 'info' | 'warning' = mean <= t.lowWarning ? 'warning' : 'info';
      ctx.setCooldownMeeting?.(meetingId, type, now, A2E2_THRESHOLDS.cooldowns.prosodic.groupEnergy);

  // Gera feedback de grupo
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
        ? `Energia do grupo baixa. Considere perguntas diretas ou mudança de dinâmica.`
        : `Energia do grupo em queda. Estimule participação.`,
    tips: ['Convide pessoas específicas a opinar', 'Introduza uma pergunta aberta'],
    metadata: {
      arousalEMA: mean,
    },
  };
}

