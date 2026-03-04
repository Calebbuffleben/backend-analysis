import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';

/**
 * Detecta interrupções frequentes.
 * 
 * Regras A2E2:
 * - Conta interrupções na janela de 60s
 * - Mínimo de 5 interrupções para considerar frequente
 * - Throttle de 2s entre amostras de overlap
 * - Cooldown específico para interrupções (90s)
 * - Identifica participantes mais envolvidos
 * 
 * @param state Não usado diretamente (usa histórico de overlap)
 * @param ctx Contexto de detecção (meetingId, now, helpers)
 * @returns FeedbackEventPayload se interrupções frequentes detectadas, null caso contrário
 */
export function detectInterruptions(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, now } = ctx;
  const participants = ctx.getParticipantsForMeeting?.(meetingId) ?? [];
  if (participants.length < 2) return null;

  const t = A2E2_THRESHOLDS.longterm.interruptions;
  const shortWindowMs = A2E2_THRESHOLDS.windows.short;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;

  // Analisa participantes falando na janela curta
  let speakingCount = 0;
  const covers: Array<{ id: string; coverage: number }> = [];

  for (const [pid, st] of participants) {
    const w = ctx.window(st, now, shortWindowMs);
    if (w.samplesCount === 0) continue;

    const coverage = w.speechCount / w.samplesCount;
    covers.push({ id: pid, coverage });
    if (coverage >= 0.2) {
      speakingCount++;
    }
  }

  // Registra overlap com throttle
  if (speakingCount >= 2) {
    const lastAt = ctx.getLastOverlapSampleAt?.(meetingId) ?? 0;
    if (now - lastAt >= t.throttleMs) {
      ctx.setLastOverlapSampleAt?.(meetingId, now);

      // Atualiza histórico de overlap
      const arr = ctx.getOverlapHistory?.(meetingId) ?? [];
      arr.push(now);
      const cutoff = now - t.windowMs;
      while (arr.length > 0 && arr[0] < cutoff) {
        arr.shift();
      }
      ctx.updateOverlapHistory?.(meetingId, arr);

      // Candidato a pós-interrupção: último falante foi “interrompido” por outro
      const lastSpeaker = ctx.getLastSpeaker?.(meetingId);
      if (lastSpeaker) {
        const someoneElseSpeaking = covers.some((c) => c.id !== lastSpeaker && c.coverage >= 0.2);
        if (someoneElseSpeaking) {
          const st = ctx.getParticipantState?.(meetingId, lastSpeaker);
          const prev = ctx.getPostInterruptionCandidates?.(meetingId) ?? [];
          const next = [...prev, {
            ts: now,
            interruptedId: lastSpeaker,
            valenceBefore: typeof st?.ema?.valence === 'number' ? st.ema.valence : undefined,
          }];
          if (next.length > 10) next.splice(0, next.length - 10);
          ctx.updatePostInterruptionCandidates?.(meetingId, next);
        }
      }
    }
  }

  // Verifica se há interrupções frequentes
  const arr = ctx.getOverlapHistory?.(meetingId) ?? [];
  if (arr.length >= t.minCount) {
    const type = 'interrupcoes_frequentes';
    if (ctx.inCooldownMeeting?.(meetingId, type, now)) return null;

    // Gradação baseada na frequência
    const interruptionsPerMin = (arr.length / t.windowMs) * 60_000;
    const severity: 'info' | 'warning' = interruptionsPerMin >= 5 ? 'warning' : 'info';

    ctx.setCooldownMeeting?.(meetingId, type, now, A2E2_THRESHOLDS.cooldowns.longTerm.interruptions);

    // Identifica participantes mais envolvidos (baseado em coverage de longo prazo)
    const longCovers = covers
      .map((c) => {
        const st = participants.find(([pid]) => pid === c.id)?.[1];
        if (!st) return { id: c.id, coverage: 0 };
        const w = ctx.window(st, now, longWindowMs);
        const cov = w.samplesCount > 0 ? w.speechCount / w.samplesCount : 0;
        return { id: c.id, coverage: cov };
      })
      .sort((a, b) => b.coverage - a.coverage)
      .slice(0, 2);

    const names = longCovers
      .map((x) => ctx.getParticipantName(meetingId, x.id) ?? x.id)
      .filter(Boolean);

    const who = names.length > 0 ? ` (${names.join(' e ')})` : '';
    const interruptionsPerMinStr = interruptionsPerMin.toFixed(1);

    return {
      id: ctx.makeId(),
      type,
      severity,
      ts: now,
      meetingId,
      participantId: 'group',
      window: { start: now - t.windowMs, end: now },
      message: `Interrupções frequentes nos últimos 60s (${interruptionsPerMinStr} por minuto)${who}. Combine turnos de fala.`,
      tips: [
        'Use levantar a mão antes de falar',
        'Defina ordem de fala',
        'Aguarde a pessoa terminar antes de começar',
        'Use sinais visuais para indicar que quer falar',
      ],
      metadata: {
        // interruptionsCount e interruptionsPerMinute não são campos permitidos no metadata
        // Informação está na mensagem
      },
    };
  }

  return null;
}

