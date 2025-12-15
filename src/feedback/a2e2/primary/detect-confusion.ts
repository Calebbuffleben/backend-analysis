import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';
import { hasRecentOverlap } from '../context/context-adjustments';

/**
 * Detecta confusão através de emoções primárias.
 * 
 * EXPANSÃO: Mensagens específicas para cada emoção (confusion vs doubt).
 * FASE 9: Padronizada lógica de detecção de emoção dominante.
 * FASE 10: Validações contextuais cruzadas refinadas.
 * FASE 10.3.1: Bloqueio por oscilação rápida.
 * 
 * Regras A2E2:
 * - Detecta confusion OU doubt acima do threshold (0.05)
 * - Usa o maior valor entre as duas emoções
 * - Requer speech coverage >= 20%
 * - Cooldown de 20s
 * 
 * Validações contextuais:
 * - Valence > 0.2 bloqueia confusão
 * - FASE 10: Bloqueio por hostilidade muito alta: rage, contempt, terror, horror > 0.10
 * - FASE 10: Bloqueio por frustração muito alta: frustration > 0.12
 * 
 * Severidade:
 * - 'warning' se valence <= 0.0
 * - 'info' se valence > 0.0
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se confusão detectada, null caso contrário
 */
export function detectConfusion(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechPrimary = A2E2_THRESHOLDS.gates.minSpeechPrimary;

  // FASE 10.3.1: Bloqueio por oscilação rápida
  // Se confusão foi detectada 3+ vezes nos últimos 30s, bloqueia para evitar spam
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    const recentConfusionCount = recentEmotions.filter((e) => e.type === 'confusao').length;
    if (recentConfusionCount >= 3) {
      return null; // Oscilação rápida detectada, bloqueia para evitar spam
    }
  }

  // Validações básicas
  const w = ctx.window(state, now, longWindowMs);
  // ETAPA 1: Mínimo ajustado de 10 para 6 amostras (janela de 10s, taxa ~1 amostra/s)
  // 6 amostras = 60% da janela esperada, permite detecção precoce de emoções primárias
  if (w.samplesCount < 6) return null;
  if (state.ema.emotions.size === 0) return null;

  // Verifica speech coverage
  const speechCoverage = w.samplesCount > 0 ? w.speechCount / w.samplesCount : 0;
  if (speechCoverage < minSpeechPrimary) return null;

  // ETAPA 5: Verificação contextual relaxada com gradação de severidade
  // Confusão geralmente tem tom neutro/negativo, mas permite detecção com severidade menor se tom está ligeiramente positivo
  const valence = state.ema.valence;
  if (typeof valence === 'number' && valence > 0.2) {
    return null; // Confusão com tom muito positivo é contraditório
  }

  // FASE 10: Validações contextuais cruzadas - hostilidade muito alta bloqueia confusão
  const rage = state.ema.emotions.get('rage') ?? 0;
  const contempt = state.ema.emotions.get('contempt') ?? 0;
  const terror = state.ema.emotions.get('terror') ?? 0;
  const horror = state.ema.emotions.get('horror') ?? 0;
  if (rage > 0.10 || contempt > 0.10 || terror > 0.10 || horror > 0.10) {
    return null; // Hostilidade ou medo muito alto prevalece sobre confusão
  }

  // FASE 10: Validações contextuais cruzadas - frustração muito alta bloqueia confusão
  const frustration = state.ema.emotions.get('frustration') ?? 0;
  if (frustration > 0.12) {
    return null; // Frustração muito alta prevalece sobre confusão
  }

  // Obtém valores de emoções
  const confusion = state.ema.emotions.get('confusion') ?? 0;
  const doubt = state.ema.emotions.get('doubt') ?? 0;

  // Verifica threshold
  const t = A2E2_THRESHOLDS.primary.confusion;
  // Verifica se qualquer emoção está acima do seu threshold específico
  const hasConfusion = confusion > t.confusion;
  const hasDoubt = doubt > t.doubt;
  if (!hasConfusion && !hasDoubt) return null;

  // FASE 9: Calcula score apenas com emoções acima do threshold
  // Se apenas uma emoção está acima do threshold, ela é o score
  // Se ambas estão acima, usa o maior valor
  const confusionValue = hasConfusion ? confusion : 0;
  const doubtValue = hasDoubt ? doubt : 0;
  const score = Math.max(confusionValue, doubtValue);

  // FASE 10.3.1: Bloqueio por sobreposição recente
  // Se confusão similar foi detectada nos últimos 20s e score atual não é > 20% maior, bloqueia
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    if (hasRecentOverlap(recentEmotions, 'confusao', score, 20_000, now)) {
      return null; // Sobreposição recente detectada, bloqueia para evitar spam
    }
  }

  // Verifica cooldowns
  const type = 'confusao';
  if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) {
    return null;
  }

  // ETAPA 5: Gradação de severidade baseada em valence
  // Se valence está entre 0.1-0.2, permite mas com severidade menor
  const severity: 'info' | 'warning' =
    typeof valence === 'number' && valence <= 0.0 ? 'warning' : 'info';

  // Define cooldown
  ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.primaryEmotion.confusion);

  // FASE 9: Gera feedback baseado na emoção dominante (padronizado)
  const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
  
  let message = `${name}: pontos de dúvida detectados. Seria bom checar o entendimento.`;
  let tips: string[] = ['Pergunte: "Isso faz sentido?"', 'Ofereça um exemplo prático'];

  // FASE 9: Mensagens específicas baseadas na emoção dominante (padronizado)
  // Padrão: emoção > threshold && emoção === score && emoção > outras na mesma categoria
  // Se apenas uma emoção está acima do threshold, ela é dominante
  // Se ambas estão acima, a maior é dominante
  const isConfusionDominant = hasConfusion && (!hasDoubt || confusion > doubt);
  const isDoubtDominant = hasDoubt && (!hasConfusion || doubt > confusion);

  if (isConfusionDominant) {
    message = `${name}: confusão detectada. O grupo parece estar confuso.`;
    tips = ['Esclareça pontos confusos', 'Faça perguntas abertas', 'Valide a confusão'];
  } else if (isDoubtDominant) {
    message = `${name}: dúvida detectada. O grupo parece ter dúvidas.`;
    tips = ['Explore a dúvida', 'Valide preocupações', 'Ofereça clareza'];
  }

  return {
    id: ctx.makeId(),
    type,
    severity,
    ts: now,
    meetingId,
    participantId,
    window: { start: w.start, end: w.end },
    message,
    tips,
    metadata: {
      speechCoverage,
    },
  };
}
