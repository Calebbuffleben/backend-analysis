import { FeedbackEventPayload } from '../../feedback.types';
import { ParticipantState, DetectionContext } from '../types';
import * as Primary from '../primary';
import * as Meta from '../metastates';
import * as Prosody from '../prosody';
import * as LongTerm from '../longterm';

/**
 * Executa o pipeline completo da Arquitetura Emocional 2.0 (A2E2).
 * 
 * A pipeline segue uma hierarquia rígida de prioridade:
 * 1. Camada 1: Emoções Primárias (maior prioridade)
 * 2. Camada 2: Meta-Estados Emocionais
 * 3. Camada 3: Sinais Prosódicos
 * 4. Camada 4: Estados de Longo Prazo (menor prioridade)
 * 
 * Cada camada para de executar assim que encontra um feedback.
 * Isso garante que apenas o feedback de maior prioridade seja retornado.
 * 
 * FALLBACK DE FRUSTRAÇÃO:
 * - PRIMARY: detectFrustration() (camada 1) - detecta frustração direta via emoção primária
 *   - Só executa se há emoções primárias (state.ema.emotions.size > 0)
 * - FALLBACK: detectFrustrationTrend() (camada 2) - detecta frustração via tendência
 *   - Só executa se NÃO há emoções primárias (state.ema.emotions.size === 0)
 *   - Detecta quando arousal aumenta E valence diminui
 * - Ambos usam o mesmo type 'frustracao_crescente' para compartilhar cooldown
 * 
 * @param state Estado do participante
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se algum feedback for detectado, null caso contrário
 */
export function runA2E2Pipeline(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  return (
    Primary.run(state, ctx) ??
    Meta.run(state, ctx) ??
    Prosody.run(state, ctx) ??
    LongTerm.run(state, ctx) ??
    null
  );
}

