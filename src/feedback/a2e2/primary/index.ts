export { detectHostility } from './detect-hostility';
export { detectFrustration } from './detect-frustration';
export { detectBoredom } from './detect-boredom';
export { detectConfusion } from './detect-confusion';
export { detectEngagement } from './detect-engagement';
export { detectSerenity } from './detect-serenity';
export { detectConnection } from './detect-connection';
export { detectSadness } from './detect-sadness';
export { detectMentalState } from './detect-mental-state';

import { FeedbackEventPayload } from '../../feedback.types';
import { ParticipantState, DetectionContext } from '../types';
import { detectHostility } from './detect-hostility';
import { detectFrustration } from './detect-frustration';
import { detectBoredom } from './detect-boredom';
import { detectConfusion } from './detect-confusion';
import { detectEngagement } from './detect-engagement';
import { detectSerenity } from './detect-serenity';
import { detectConnection } from './detect-connection';
import { detectSadness } from './detect-sadness';
import { detectMentalState } from './detect-mental-state';

/**
 * Executa todas as heurísticas de emoções primárias na ordem de prioridade.
 * 
 * Ordem de execução (FASE 1):
 * 1. Hostilidade (urgência máxima)
 * 2. Frustração (urgência alta)
 * 3. Tristeza (urgência média-alta) - NOVO
 * 4. Tédio (urgência média)
 * 5. Confusão (urgência média)
 * 6. Engajamento (positividade)
 * 7. Serenidade (positividade suave) - NOVO
 * 8. Conexão (positividade social) - NOVO
 * 9. Estado Mental (contexto/neutro) - NOVO
 * 
 * Retorna o primeiro feedback encontrado ou null se nenhum for detectado.
 * 
 * Nota: A ordem de prioridade pode ser ajustada nas fases seguintes baseado em
 * dados reais e validações contextuais cruzadas.
 */
export function run(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  return (
    detectHostility(state, ctx) ??
    detectFrustration(state, ctx) ??
    detectSadness(state, ctx) ??
    detectBoredom(state, ctx) ??
    detectConfusion(state, ctx) ??
    detectEngagement(state, ctx) ??
    detectSerenity(state, ctx) ??
    detectConnection(state, ctx) ??
    detectMentalState(state, ctx) ??
    null
  );
}

