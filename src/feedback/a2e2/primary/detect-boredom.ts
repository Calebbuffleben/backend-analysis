import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';
import { hasRecentOverlap } from '../context/context-adjustments';

/**
 * Detecta tédio através de emoções primárias.
 * 
 * EXPANSÃO: Mensagens específicas para cada emoção (boredom vs tiredness).
 * FASE 9: Padronizada lógica de detecção de emoção dominante.
 * FASE 10: Validações contextuais cruzadas refinadas.
 * FASE 10.3.1: Bloqueio por oscilação rápida.
 * 
 * Regras A2E2:
 * - Detecta boredom > 0.05 OU tiredness > 0.08
 * - E interest < 0.05 (baixo interesse confirma tédio)
 * - Requer speech coverage >= 15%
 * - Cooldown de 25s
 * 
 * Validações contextuais:
 * - Frustração > 0.05 bloqueia tédio
 * - FASE 10: Bloqueio por hostilidade muito alta: rage, contempt, terror, horror > 0.10
 * 
 * Severidade:
 * - 'warning' se frustração <= 0.03
 * - 'info' se frustração > 0.03
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se tédio detectado, null caso contrário
 */
export function detectBoredom(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechPrimary = A2E2_THRESHOLDS.gates.minSpeechPrimary;

  // FASE 10.3.1: Bloqueio por oscilação rápida
  // Se tédio foi detectado 3+ vezes nos últimos 30s, bloqueia para evitar spam
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    const recentBoredomCount = recentEmotions.filter((e) => e.type === 'tedio').length;
    if (recentBoredomCount >= 3) {
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
  // Tédio pode coexistir com pequena frustração, mas frustração significativa prevalece
  const frustration = state.ema.emotions.get('frustration') ?? 0;
  if (frustration > 0.05) {
    return null; // Frustração significativa prevalece sobre tédio
  }

  // FASE 10: Validações contextuais cruzadas - hostilidade muito alta bloqueia tédio
  const rage = state.ema.emotions.get('rage') ?? 0;
  const contempt = state.ema.emotions.get('contempt') ?? 0;
  const terror = state.ema.emotions.get('terror') ?? 0;
  const horror = state.ema.emotions.get('horror') ?? 0;
  if (rage > 0.10 || contempt > 0.10 || terror > 0.10 || horror > 0.10) {
    return null; // Hostilidade ou medo muito alto prevalece sobre tédio
  }

  // Obtém valores de emoções
  const boredom = state.ema.emotions.get('boredom') ?? 0;
  const tiredness = state.ema.emotions.get('tiredness') ?? 0;
  const interest = state.ema.emotions.get('interest') ?? 0;

  // Verifica thresholds
  const t = A2E2_THRESHOLDS.primary.boredom;
  const hasBoredom = boredom > t.boredom;
  const hasTiredness = tiredness > t.tiredness;
  const hasBoredomOrTiredness = hasBoredom || hasTiredness;
  const hasLowInterest = interest < t.interestLow;

  if (!hasBoredomOrTiredness || !hasLowInterest) return null;

  // FASE 9: Calcula score apenas com emoções acima do threshold
  // Se apenas uma emoção está acima do threshold, ela é o score
  // Se ambas estão acima, usa o maior valor
  const boredomValue = hasBoredom ? boredom : 0;
  const tirednessValue = hasTiredness ? tiredness : 0;
  const score = Math.max(boredomValue, tirednessValue);

  // FASE 10.3.1: Bloqueio por sobreposição recente
  // Se tédio similar foi detectado nos últimos 20s e score atual não é > 20% maior, bloqueia
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    if (hasRecentOverlap(recentEmotions, 'tedio', score, 20_000, now)) {
      return null; // Sobreposição recente detectada, bloqueia para evitar spam
    }
  }

  // Verifica cooldowns
  const type = 'tedio';
  if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) {
    return null;
  }

  // ETAPA 5: Gradação de severidade baseada em frustração
  // Se frustração está entre 0.03-0.05, permite mas com severidade menor
  const severity: 'info' | 'warning' = frustration > 0.03 ? 'info' : 'warning';

  // Define cooldown
  ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.primaryEmotion.boredom);

  // FASE 9: Gera feedback baseado na emoção dominante (padronizado)
  const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
  
  let message = `${name}: energia baixa detectada. Que tal trazer um novo ponto de vista?`;
  let tips: string[] = ['Mude a entonação', 'Faça uma pergunta aberta ao grupo'];

  // FASE 9: Mensagens específicas baseadas na emoção dominante (padronizado)
  // Padrão: emoção > threshold && emoção === score && emoção > outras na mesma categoria
  // Se apenas uma emoção está acima do threshold, ela é dominante
  // Se ambas estão acima, a maior é dominante
  const isBoredomDominant = hasBoredom && (!hasTiredness || boredom > tiredness);
  const isTirednessDominant = hasTiredness && (!hasBoredom || tiredness > boredom);

  if (isBoredomDominant) {
    message = `${name}: tédio detectado. O grupo parece desinteressado.`;
    tips = ['Varie a dinâmica', 'Engaje de forma diferente', 'Considere fazer uma pausa'];
  } else if (isTirednessDominant) {
    message = `${name}: cansaço detectado. O grupo parece estar cansado.`;
    tips = ['Considere fazer uma pausa', 'Reduza o ritmo', 'Ofereça um momento de descanso'];
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
      arousalEMA: state.ema.arousal,
      speechCoverage,
    },
  };
}
