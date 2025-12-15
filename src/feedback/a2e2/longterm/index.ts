export { detectSilence } from './detect-silence';
export { detectOverlap } from './detect-overlap';
export { detectInterruptions } from './detect-interruptions';

import { FeedbackEventPayload } from '../../feedback.types';
import { ParticipantState, DetectionContext } from '../types';
import { detectSilence } from './detect-silence';
import { detectOverlap } from './detect-overlap';
import { detectInterruptions } from './detect-interruptions';

/**
 * Executa todas as heurísticas de longo prazo na ordem de prioridade.
 * 
 * Ordem de execução:
 * 1. Silêncio Prolongado
 * 2. Overlap de Fala
 * 3. Interrupções Frequentes
 * 
 * Retorna o primeiro feedback encontrado ou null se nenhum for detectado.
 */
export function run(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  // 4.1 Silêncio Prolongado
  const silenceResult = detectSilence(state, ctx);
  if (silenceResult) return silenceResult;

  // 4.2 Overlap de Fala
  const overlapResult = detectOverlap(state, ctx);
  if (overlapResult) return overlapResult;

  // 4.3 Interrupções Frequentes
  const interruptionsResult = detectInterruptions(state, ctx);
  if (interruptionsResult) return interruptionsResult;

  return null;
}

