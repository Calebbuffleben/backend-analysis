import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';

/**
 * Tipo para registro de candidato a interrupção
 */
type PostInterruptionCandidate = {
  ts: number;
  interruptedId: string;
  valenceBefore?: number;
};

/**
 * Detecta queda de valence após interrupção.
 * 
 * Regras A2E2:
 * - Verifica candidatos registrados em janela de 6s a 30s após interrupção
 * - Valence deve ter caído (delta <= threshold)
 * - Speech coverage >= threshold
 * 
 * @param state Não usado diretamente (usa lista de candidatos)
 * @param ctx Contexto de detecção (meetingId, now, helpers)
 * @returns FeedbackEventPayload se efeito pós-interrupção detectado, null caso contrário
 */
export function detectPostInterruption(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, now } = ctx;
  const list = ctx.getPostInterruptionCandidates?.(meetingId);
  if (!list || list.length === 0) return null;

  const t = A2E2_THRESHOLDS.metastates.postInterruption;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const remaining: PostInterruptionCandidate[] = [];

  for (const rec of list) {
    const age = now - rec.ts;
    
    // Aguarda janela mínima (6s)
    if (age < t.windowMin) {
      remaining.push(rec);
      continue;
    }
    
    // Expira após janela máxima (30s)
    if (age > t.windowMax) {
      continue; // expired
    }

    // Obtém estado atual do participante interrompido
    const st = ctx.getParticipantState?.(meetingId, rec.interruptedId);
    if (!st || typeof st.ema.valence !== 'number' || typeof rec.valenceBefore !== 'number') {
      remaining.push(rec);
      continue;
    }

    // Calcula delta de valence
    const delta = st.ema.valence - rec.valenceBefore;
    
    // Verifica speech coverage
    const w = ctx.window(st, now, longWindowMs);
    const coverage = w.samplesCount > 0 ? w.speechCount / w.samplesCount : 0;

    // Verifica se há queda significativa de valence e coverage suficiente
    if (delta <= t.valenceDelta && coverage >= t.minCoverage) {
      const type = 'efeito_pos_interrupcao';
      if (!ctx.inCooldown(st, type, now)) {
        ctx.setCooldown(st, type, now, A2E2_THRESHOLDS.cooldowns.meta.postInterruption);
        
        const name = ctx.getParticipantName(meetingId, rec.interruptedId) ?? rec.interruptedId;
        return {
          id: ctx.makeId(),
          type,
          severity: 'warning',
          ts: now,
          meetingId,
          participantId: rec.interruptedId,
          window: { start: rec.ts, end: now },
          message: `${name}: queda de ânimo após interrupção.`,
          tips: ['Convide a concluir a ideia interrompida', 'Garanta espaço de fala'],
          metadata: {
            valenceEMA: st.ema.valence,
            speechCoverage: coverage,
          },
        };
      }
    } else {
      remaining.push(rec);
    }
  }

  // Atualiza lista de candidatos (remove expirados e processados)
  ctx.updatePostInterruptionCandidates?.(meetingId, remaining);
  return null;
}

