import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';
import { calculateTensionLevel, getSerenityThreshold, hasRecentOverlap } from '../context/context-adjustments';
import { contextualizeMessage } from '../context/message-contextualizer';

/**
 * Detecta serenidade através de emoções primárias.
 * 
 * FASE 8: Expandido com mensagens específicas para cada emoção de serenidade.
 * FASE 9: Padronizada lógica de detecção de emoção dominante.
 * FASE 10: Validações contextuais cruzadas refinadas.
 * FASE 10.1: Validações bidirecionais, combinações e níveis graduais de bloqueio.
 * FASE 10.2: Validações baseadas em intensidade relativa e expansão para tristeza/frustração.
 * FASE 10.3.1: Thresholds dinâmicos e mensagens contextuais.
 * 
 * Regras A2E2:
 * - Detecta calmness, contentment, relief OU satisfaction acima do threshold (0.08)
 * - Usa o maior valor entre as quatro emoções
 * - Requer speech coverage >= 18%
 * - Cooldown de 90s (mais longo pois não é urgente)
 * 
 * Validações contextuais:
 * - Bloqueio por hostilidade/medo: todas as emoções de hostilidade e medo/ameaça > 0.05
 * - Arousal máximo: 0.4 (serenidade requer baixa energia)
 * - Valence mínimo: 0.0 (serenidade requer tom neutro/positivo)
 * - Frustração: > 0.10 bloqueia serenidade
 * - FASE 10: Bloqueio por desespero/grief muito alto: despair, grief > 0.12
 * - FASE 10: Bloqueio por tristeza moderada-alta: sorrow, sadness, melancholy > 0.10
 * - FASE 10.1: Bloqueio por hostilidade baixa: rage > 0.04, anger > 0.04 (refinamento)
 * - FASE 10.1: Bloqueio por combinação hostilidade + frustração: (rage > 0.04 || anger > 0.04) && frustration > 0.06
 * 
 * Severidade:
 * - Sempre 'info' (serenidade não é urgente)
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se serenidade detectada, null caso contrário
 */
export function detectSerenity(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechPrimary = A2E2_THRESHOLDS.gates.minSpeechPrimary;

  // FASE 10.3.1: Bloqueio por oscilação rápida
  // Se serenidade foi detectada 3+ vezes nos últimos 30s, bloqueia para evitar spam
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    const recentSerenityCount = recentEmotions.filter((e) => e.type === 'serenidade').length;
    if (recentSerenityCount >= 3) {
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

  // FASE 1: Validações contextuais básicas
  // Serenidade requer baixa energia e tom neutro/positivo
  // Obtém arousal e valence para validações e cálculo de tensão
  const arousal = state.ema.arousal;
  const valence = state.ema.valence;
  // FASE 2: Inclui todas as emoções de hostilidade e medo/ameaça
  const anger = state.ema.emotions.get('anger') ?? 0;
  const disgust = state.ema.emotions.get('disgust') ?? 0;
  const distress = state.ema.emotions.get('distress') ?? 0;
  const rage = state.ema.emotions.get('rage') ?? 0;
  const contempt = state.ema.emotions.get('contempt') ?? 0;
  const fear = state.ema.emotions.get('fear') ?? 0;
  const horror = state.ema.emotions.get('horror') ?? 0;
  const terror = state.ema.emotions.get('terror') ?? 0;
  const anxiety = state.ema.emotions.get('anxiety') ?? 0;
  const frustration = state.ema.emotions.get('frustration') ?? 0;

  // Bloqueios absolutos (contradições lógicas claras)
  if (typeof arousal === 'number' && arousal > 0.4) {
    return null; // Serenidade requer baixa energia
  }
  if (typeof valence === 'number' && valence < 0.0) {
    return null; // Serenidade requer tom neutro/positivo
  }
  // FASE 2: Bloqueio básico por hostilidade e medo/ameaça (threshold baixo 0.05)
  // FASE 10.1: Validações graduais - múltiplos níveis de bloqueio
  // Nível 1 - Bloqueio absoluto: hostilidade/medo muito alta (> 0.05)
  if (
    anger > 0.05 ||
    disgust > 0.05 ||
    distress > 0.05 ||
    rage > 0.05 ||
    contempt > 0.05 ||
    fear > 0.05 ||
    horror > 0.05 ||
    terror > 0.05 ||
    anxiety > 0.05
  ) {
    return null; // Serenidade com hostilidade ou medo significativo é contraditório
  }
  
  // FASE 10.1: Validações bidirecionais - hostilidade baixa bloqueia serenidade
  // Nível 3 - Bloqueio moderado: hostilidade baixa (> 0.04) bloqueia serenidade (mais sensível)
  // Serenidade é mais sensível a hostilidade que outros detectores positivos
  if (rage > 0.04 || anger > 0.04 || contempt > 0.04) {
    return null; // Hostilidade baixa prevalece sobre serenidade
  }
  
  if (frustration > 0.10) {
    return null; // Frustração significativa prevalece sobre serenidade
  }

  // FASE 10.1: Validações baseadas em combinações - hostilidade + frustração
  // Combinação de hostilidade muito baixa + frustração moderada também bloqueia
  if ((rage > 0.04 || anger > 0.04 || contempt > 0.04) && frustration > 0.06) {
    return null; // Combinação hostilidade + frustração prevalece sobre serenidade
  }

  // FASE 10: Validações contextuais cruzadas - desespero/grief muito alto bloqueia serenidade
  const despair = state.ema.emotions.get('despair') ?? 0;
  const grief = state.ema.emotions.get('grief') ?? 0;
  if (despair > 0.12 || grief > 0.12) {
    return null; // Desespero ou luto muito profundo prevalece sobre serenidade
  }

  // FASE 10: Validações contextuais cruzadas - tristeza moderada-alta bloqueia serenidade
  const sorrow = state.ema.emotions.get('sorrow') ?? 0;
  const sadness = state.ema.emotions.get('sadness') ?? 0;
  const melancholy = state.ema.emotions.get('melancholy') ?? 0;
  if (sorrow > 0.10 || sadness > 0.10 || melancholy > 0.10) {
    return null; // Tristeza moderada-alta prevalece sobre serenidade
  }

  // FASE 10.1: Validações baseadas em combinações - tristeza + frustração
  // Combinação de tristeza baixa + frustração moderada também bloqueia
  if ((sadness > 0.08 || despair > 0.08 || grief > 0.08 || sorrow > 0.08) && frustration > 0.06) {
    return null; // Combinação tristeza + frustração prevalece sobre serenidade
  }

  // FASE 10.1: Validações baseadas em combinações - hostilidade + tristeza
  // Combinação de hostilidade muito baixa + tristeza moderada também bloqueia
  if ((rage > 0.04 || anger > 0.04 || contempt > 0.04) && (sadness > 0.08 || despair > 0.08 || grief > 0.08 || sorrow > 0.08)) {
    return null; // Combinação hostilidade + tristeza prevalece sobre serenidade
  }

  // FASE 10.1: Validações graduais para medo/ameaça - medo baixo bloqueia serenidade
  // Medo/ameaça baixa (> 0.04) bloqueia serenidade (mais sensível, similar a hostilidade)
  if (terror > 0.04 || horror > 0.04 || fear > 0.04 || anxiety > 0.04) {
    return null; // Medo/ameaça baixa prevalece sobre serenidade
  }

  // FASE 10.2: Expansão de validações - tristeza baixa bloqueia serenidade
  // Tristeza baixa (> 0.08) bloqueia serenidade (mais sensível que outros detectores)
  if (sadness > 0.08 || melancholy > 0.08) {
    return null; // Tristeza baixa prevalece sobre serenidade
  }

  // FASE 10.2: Expansão de validações - frustração baixa bloqueia serenidade
  // Frustração baixa (> 0.08) bloqueia serenidade
  if (frustration > 0.08) {
    return null; // Frustração baixa prevalece sobre serenidade
  }

  // Obtém valores de emoções
  const calmness = state.ema.emotions.get('calmness') ?? 0;
  const contentment = state.ema.emotions.get('contentment') ?? 0;
  const relief = state.ema.emotions.get('relief') ?? 0;
  const satisfaction = state.ema.emotions.get('satisfaction') ?? 0;
  const score = Math.max(calmness, contentment, relief, satisfaction);

  // FASE 10.3.1: Bloqueio por sobreposição recente
  // Se serenidade similar foi detectada nos últimos 20s e score atual não é > 20% maior, bloqueia
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    if (hasRecentOverlap(recentEmotions, 'serenidade', score, 20_000, now)) {
      return null; // Sobreposição recente detectada, bloqueia para evitar spam
    }
  }

  // FASE 10.3.1: Calcula nível de tensão e ajusta thresholds dinamicamente
  // (arousal e valence já obtidos acima)
  const tensionLevel = ctx.getTensionLevel ? ctx.getTensionLevel(state) : calculateTensionLevel(arousal, valence);
  
  // Verifica threshold com ajuste dinâmico
  const t = A2E2_THRESHOLDS.primary.serenity;
  const tAdjusted = {
    calmness: getSerenityThreshold(t.calmness, tensionLevel),
    contentment: getSerenityThreshold(t.contentment, tensionLevel),
    relief: getSerenityThreshold(t.relief, tensionLevel),
    satisfaction: getSerenityThreshold(t.satisfaction, tensionLevel),
  };
  
  if (score <= tAdjusted.calmness) return null;

  // FASE 10.2: Validações baseadas em intensidade relativa
  // Calcula scores de emoções negativas para comparação
  const activeHostilityScore = Math.max(rage, anger, contempt, disgust, distress);
  const threatScore = Math.max(terror, horror, fear, anxiety);
  const hostilityScore = Math.max(activeHostilityScore, threatScore);
  const deepSadnessScore = Math.max(despair, grief, sorrow);
  const directSadnessScore = Math.max(sadness, melancholy);
  const sadnessScore = Math.max(deepSadnessScore, directSadnessScore);

  // FASE 10.2: Validações baseadas em subcategorias de serenidade
  // Serenidade reativa (relief, satisfaction) é mais resistente (resultado de resolução)
  const reactiveSerenityScore = Math.max(relief, satisfaction);
  const basalSerenityScore = Math.max(calmness, contentment);
  const hasReactiveSerenity = relief > tAdjusted.relief || satisfaction > tAdjusted.satisfaction;
  const hasBasalSerenity = calmness > tAdjusted.calmness || contentment > tAdjusted.contentment;

  // Serenidade reativa pode coexistir com tristeza/frustração baixa que bloquearia serenidade basal
  if (hasReactiveSerenity) {
    // Bloqueia serenidade reativa apenas se hostilidade/tristeza/frustração é 80% da serenidade
    if (hostilityScore > reactiveSerenityScore * 0.8 || sadnessScore > reactiveSerenityScore * 0.8 || frustration > reactiveSerenityScore * 0.8) {
      return null; // Emoções negativas altas bloqueiam serenidade reativa
    }
  } else if (hasBasalSerenity) {
    // Serenidade basal é mais sensível - bloqueia se hostilidade/tristeza/frustração é 60% da serenidade
    if (hostilityScore > basalSerenityScore * 0.6 || sadnessScore > basalSerenityScore * 0.6 || frustration > basalSerenityScore * 0.6) {
      return null; // Emoções negativas moderadas bloqueiam serenidade basal
    }
  }

  // Validações gerais baseadas em score total (fallback se não há subcategoria clara)
  // Hostilidade vs Serenidade: bloqueia se hostilidade é igual ou maior que serenidade
  if (hostilityScore >= score * 1.0) {
    return null; // Hostilidade igual ou maior que serenidade prevalece
  }

  // Tristeza vs Serenidade: bloqueia se tristeza é 80% da serenidade
  if (sadnessScore > score * 0.8) {
    return null; // Tristeza moderada prevalece sobre serenidade
  }

  // Frustração vs Serenidade: bloqueia se frustração é 60% da serenidade
  if (frustration > score * 0.6) {
    return null; // Frustração moderada prevalece sobre serenidade
  }

  // Verifica cooldowns
  const type = 'serenidade';
  if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) {
    return null;
  }

  // FASE 8: Severidade sempre 'info' (serenidade não é urgente)
  const severity: 'info' | 'warning' = 'info';

  // Define cooldown
  ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.primaryEmotion.serenity);

  // FASE 8: Gera feedback baseado na emoção dominante
  const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
  
  let message = `${name}: ambiente tranquilo detectado. Bom momento para reflexão ou síntese.`;
  let tips: string[] = ['Aproveite o momento de calma', 'Considere fazer uma síntese do que foi discutido'];

  // Mensagens específicas baseadas na emoção dominante
  // Verifica se há uma emoção claramente dominante (é a única que contribui para o score)
  const isCalmnessDominant = calmness > tAdjusted.calmness && calmness === score && 
    calmness > Math.max(contentment, relief, satisfaction);
  const isContentmentDominant = contentment > tAdjusted.contentment && contentment === score && 
    contentment > Math.max(calmness, relief, satisfaction);
  const isReliefDominant = relief > tAdjusted.relief && relief === score && 
    relief > Math.max(calmness, contentment, satisfaction);
  const isSatisfactionDominant = satisfaction > tAdjusted.satisfaction && satisfaction === score && 
    satisfaction > Math.max(calmness, contentment, relief);

  if (isCalmnessDominant) {
    message = `${name}: calma detectada. Ambiente tranquilo e sereno.`;
    tips = ['Aproveite a calma', 'Mantenha o ambiente tranquilo', 'Respeite o momento de paz'];
  } else if (isContentmentDominant) {
    message = `${name}: contentamento detectado. Ambiente de satisfação leve e bem-estar.`;
    tips = ['Reconheça o contentamento', 'Mantenha o tom positivo', 'Aproveite o momento'];
  } else if (isReliefDominant) {
    message = `${name}: alívio detectado. Momento de relaxamento após tensão.`;
    tips = ['Reconheça o alívio', 'Aproveite o momento de calma', 'Mantenha o ambiente positivo'];
  } else if (isSatisfactionDominant) {
    message = `${name}: satisfação detectada. Ambiente de contentamento e realização.`;
    tips = ['Reconheça a satisfação', 'Celebre o momento', 'Mantenha o tom positivo'];
  }

  // FASE 10.3.1: Contextualiza mensagem baseado em histórico e intensidade relativa
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 60_000, now);
    // Calcula intensidade relativa de tristeza (se tristeza está entre 60-80% da serenidade)
    const relativeIntensity = sadnessScore > 0 ? sadnessScore / score : undefined;
    const contextualized = contextualizeMessage(message, tips, {
      recentEmotions,
      relativeIntensity,
      conflictingEmotions: sadnessScore > 0 ? [{ type: 'tristeza', score: sadnessScore }] : undefined,
      currentEmotionType: 'serenidade',
    });
    message = contextualized.message;
    tips = contextualized.tips;
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
      valenceEMA: state.ema.valence,
      arousalEMA: state.ema.arousal,
      speechCoverage,
    },
  };
}

