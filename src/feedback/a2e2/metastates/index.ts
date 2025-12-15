export { detectFrustrationTrend } from './detect-frustration-trend';
export { detectPostInterruption } from './detect-post-interruption';
export { detectPolarization } from './detect-polarization';

import { FeedbackEventPayload } from '../../feedback.types';
import { ParticipantState, DetectionContext } from '../types';
import { detectFrustrationTrend } from './detect-frustration-trend';
import { detectPostInterruption } from './detect-post-interruption';
import { detectPolarization } from './detect-polarization';

/**
 * Executa todas as heurísticas de meta-estados emocionais na ordem de prioridade.
 * 
 * Ordem de execução:
 * 1. Frustração Crescente (tendência) - FALLBACK quando não há emoções primárias
 * 2. Efeito Pós-Interrupção
 * 3. Polarização Emocional
 * 
 * Nota: detectFrustrationTrend() funciona como fallback de detectFrustration() (primary).
 * Se há emoções primárias, a frustração é detectada na camada primary.
 * Se não há emoções primárias, detectFrustrationTrend() tenta detectar via tendência.
 * 
 * Retorna o primeiro feedback encontrado ou null se nenhum for detectado.
 */
export function run(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  return (
    detectFrustrationTrend(state, ctx) ??
    detectPostInterruption(state, ctx) ??
    detectPolarization(state, ctx) ??
    null
  );
}

