import { FeedbackEventPayload } from '../../feedback.types';
import { ParticipantState, DetectionContext } from '../types';
import * as TextAnalysis from '../text-analysis';

/**
 * Executa a pipeline de análise de texto (Text Analysis) para feedbacks de vendas.
 * 
 * Esta pipeline roda INDEPENDENTEMENTE da pipeline A2E2 principal (emoções/prosódia),
 * permitindo que feedbacks de vendas sejam publicados no mesmo turno que feedbacks emocionais.
 * 
 * A pipeline de Text Analysis executa na seguinte ordem:
 * 1. Detecção de Indecisão do Cliente (sales_client_indecision)
 * 2. Detecção de Solução Compreendida (sales_solution_understood)
 * 
 * Retorna o primeiro feedback encontrado ou null se nenhum for detectado.
 * 
 * NOTA: Esta pipeline é executada separadamente da runA2E2Pipeline porque:
 * - Feedbacks de vendas e feedbacks emocionais não competem entre si
 * - Ambos podem ser publicados no mesmo turno se detectados
 * - A pipeline A2E2 principal usa short-circuit (??), o que bloquearia um ou outro
 * 
 * @param state Estado do participante com dados de análise de texto
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers, solution context)
 * @returns FeedbackEventPayload se algum feedback de vendas for detectado, null caso contrário
 */
export function runTextAnalysisPipeline(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  return TextAnalysis.run(state, ctx);
}

