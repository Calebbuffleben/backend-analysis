import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';
import { calculateTensionLevel, getDeepSadnessThreshold, getThresholdByTrend, hasConsistentTrend, hasRecentOverlap, calculateEmotionTrend } from '../context/context-adjustments';
import { contextualizeMessage } from '../context/message-contextualizer';

/**
 * Detecta tristeza através de emoções primárias.
 * 
 * FASE 6: Expandido com 6 novas emoções (grief, loneliness, melancholy, regret, sorrow, despair).
 * FASE 9: Padronizada lógica de detecção de emoção dominante.
 * FASE 10.2: Validações baseadas em subcategorias (profunda vs direta).
 * FASE 10.3.1: Thresholds dinâmicos e mensagens contextuais.
 * 
 * Regras A2E2:
 * - Detecta múltiplas emoções de tristeza acima dos thresholds
 * - Usa subcategorias:
 *   - Tristeza direta: sadness, disappointment, sorrow
 *   - Autoavaliação negativa: guilt, shame, embarrassment, regret
 *   - Julgamento: disapproval
 *   - Luto/Perda profunda: grief, despair
 *   - Isolamento: loneliness, melancholy
 * - Requer speech coverage >= 18%
 * - Cooldown de 40s (moderado-alto, requer atenção mas não é urgente como hostilidade)
 * 
 * Validações contextuais:
 * - Bloqueio por hostilidade extrema: rage, contempt, anger, disgust, distress > 0.10
 * - Bloqueio por medo extremo: terror, horror, fear > 0.10
 * - Valence máximo: 0.1 (tristeza requer tom negativo)
 * 
 * Severidade:
 * - Despair muito alto (>= 0.15): sempre 'warning' (desespero é crítico)
 * - Shame/Guilt muito altos (>= 0.15): sempre 'warning'
 * - Embarrassment alto (>= 0.15): 'warning'
 * - Grief muito alto (>= 0.15): 'warning' (luto profundo requer atenção)
 * - Outras: 'info' (tristeza não é urgente como hostilidade)
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se tristeza detectada, null caso contrário
 */
export function detectSadness(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechPrimary = A2E2_THRESHOLDS.gates.minSpeechPrimary;

  // FASE 10.3.1: Bloqueio por oscilação rápida
  // Se tristeza foi detectada 3+ vezes nos últimos 30s, bloqueia para evitar spam
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    const recentSadnessCount = recentEmotions.filter((e) => e.type === 'tristeza').length;
    if (recentSadnessCount >= 3) {
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

  // FASE 4: Validações contextuais refinadas
  // Tristeza requer tom negativo, mas hostilidade extrema prevalece
  // Obtém arousal e valence para validações e cálculo de tensão
  const valence = state.ema.valence;
  const arousal = state.ema.arousal;
  // FASE 2: Inclui todas as emoções de hostilidade e medo/ameaça extremos
  const anger = state.ema.emotions.get('anger') ?? 0;
  const disgust = state.ema.emotions.get('disgust') ?? 0;
  const distress = state.ema.emotions.get('distress') ?? 0;
  const rage = state.ema.emotions.get('rage') ?? 0;
  const contempt = state.ema.emotions.get('contempt') ?? 0;
  const fear = state.ema.emotions.get('fear') ?? 0;
  const horror = state.ema.emotions.get('horror') ?? 0;
  const terror = state.ema.emotions.get('terror') ?? 0;
  const anxiety = state.ema.emotions.get('anxiety') ?? 0;

  // Bloqueios absolutos (contradições lógicas claras)
  if (typeof valence === 'number' && valence > 0.1) {
    return null; // Tristeza requer tom negativo
  }
  // FASE 4: Hostilidade extrema ou medo extremo prevalece sobre tristeza
  // Threshold mais alto (0.10) para permitir que tristeza coexista com hostilidade moderada
  if (
    rage > 0.10 ||
    contempt > 0.10 ||
    terror > 0.10 ||
    horror > 0.10 ||
    anger > 0.10 ||
    disgust > 0.10 ||
    distress > 0.10 ||
    fear > 0.10
  ) {
    return null; // Hostilidade ou medo extremo prevalece sobre tristeza
  }
  
  // FASE 4: Validação adicional - tristeza pode coexistir com frustração moderada
  // mas frustração muito alta pode indicar hostilidade ao invés de tristeza
  const frustration = state.ema.emotions.get('frustration') ?? 0;
  if (frustration > 0.15) {
    return null; // Frustração muito alta pode ser hostilidade, não tristeza
  }

  // FASE 6: Obtém valores de emoções por subcategoria
  const sadness = state.ema.emotions.get('sadness') ?? 0;
  const disappointment = state.ema.emotions.get('disappointment') ?? 0;
  const guilt = state.ema.emotions.get('guilt') ?? 0;
  const shame = state.ema.emotions.get('shame') ?? 0;
  const embarrassment = state.ema.emotions.get('embarrassment') ?? 0;
  const disapproval = state.ema.emotions.get('disapproval') ?? 0;
  // FASE 6: Novas emoções
  const grief = state.ema.emotions.get('grief') ?? 0;
  const loneliness = state.ema.emotions.get('loneliness') ?? 0;
  const melancholy = state.ema.emotions.get('melancholy') ?? 0;
  const regret = state.ema.emotions.get('regret') ?? 0;
  const sorrow = state.ema.emotions.get('sorrow') ?? 0;
  const despair = state.ema.emotions.get('despair') ?? 0;

  // FASE 10.3.1: Calcula nível de tensão e ajusta thresholds dinamicamente
  // (arousal e valence já obtidos acima)
  const tensionLevel = ctx.getTensionLevel ? ctx.getTensionLevel(state) : calculateTensionLevel(arousal, valence);
  
  // FASE 10.3.1: Calcula tendência temporal para emoções críticas
  const getEmotionTrendValue = (emotionName: string): 'increasing' | 'decreasing' | 'stable' => {
    if (ctx.getEmotionTrend) {
      return ctx.getEmotionTrend(state, emotionName, 10_000, now);
    }
    // Fallback: calcula tendência baseada no histórico de emoções
    if (ctx.getRecentEmotions) {
      const recentEmotions = ctx.getRecentEmotions(state, 10_000, now);
      return calculateEmotionTrend(recentEmotions, emotionName, 10_000, now);
    }
    return 'stable';
  };
  
  // FASE 6: Calcula scores por subcategoria
  const t = A2E2_THRESHOLDS.primary.sadness;
  
  // Aplica ajustes por tensão primeiro, depois por tendência temporal (apenas para tristeza profunda)
  const tAdjusted = {
    // Tristeza direta: mantém threshold base (não aplica tendência temporal)
    sadness: t.sadness,
    disappointment: t.disappointment,
    sorrow: t.sorrow,
    // Autoavaliação: mantém threshold base (não aplica tendência temporal)
    guilt: t.guilt,
    shame: t.shame,
    embarrassment: t.embarrassment,
    regret: t.regret,
    // Julgamento: mantém threshold base
    disapproval: t.disapproval,
    // Tristeza profunda: ajusta em alta tensão + tendência temporal
    grief: getThresholdByTrend(getDeepSadnessThreshold(t.grief, tensionLevel), getEmotionTrendValue('grief'), 'negative'),
    despair: getThresholdByTrend(getDeepSadnessThreshold(t.despair, tensionLevel), getEmotionTrendValue('despair'), 'negative'),
    // Isolamento: mantém threshold base
    loneliness: t.loneliness,
    melancholy: t.melancholy,
  };
  
  // FASE 10.3.1: Validação por tendência consistente
  // Se tristeza profunda está aumentando consistentemente (3+ detecções consecutivas), reduz threshold adicional
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    if (hasConsistentTrend(recentEmotions, 'tristeza', 30_000, now)) {
      // Aplica redução adicional de 10% para detecção precoce (apenas para tristeza profunda)
      tAdjusted.grief = tAdjusted.grief * 0.9;
      tAdjusted.despair = tAdjusted.despair * 0.9;
    }
  }
  
  const directSadness = Math.max(sadness, disappointment, sorrow);
  const selfEvaluation = Math.max(guilt, shame, embarrassment, regret);
  const judgment = disapproval;
  const deepLoss = Math.max(grief, despair);
  const isolation = Math.max(loneliness, melancholy);
  
  // FASE 10.3.1: Bloqueio por sobreposição recente
  // Se tristeza similar foi detectada nos últimos 20s e score atual não é > 20% maior, bloqueia
  const sadnessScore = Math.max(directSadness, selfEvaluation, judgment, deepLoss, isolation);
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    if (hasRecentOverlap(recentEmotions, 'tristeza', sadnessScore, 20_000, now)) {
      return null; // Sobreposição recente detectada, bloqueia para evitar spam
    }
  }

  // FASE 6: Verifica thresholds por subcategoria com ajustes dinâmicos
  const hasDirectSadness = directSadness > tAdjusted.sadness;
  const hasSelfEvaluation = selfEvaluation > tAdjusted.guilt;
  const hasJudgment = judgment > tAdjusted.disapproval;
  const hasDeepLoss = deepLoss > tAdjusted.grief;
  const hasIsolation = isolation > tAdjusted.loneliness;

  // Precisa ter pelo menos uma subcategoria acima do threshold
  if (!hasDirectSadness && !hasSelfEvaluation && !hasJudgment && !hasDeepLoss && !hasIsolation) {
    return null;
  }

  // FASE 6: Usa o maior score entre todas as subcategorias
  const score = sadnessScore; // Já calculado acima para verificação de sobreposição

  // Verifica cooldowns
  const type = 'tristeza';
  if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) {
    return null;
  }

  // FASE 6: Gradação de severidade baseada em subcategoria e emoção específica
  // Despair/Grief muito altos são críticos, assim como Shame/Guilt/Embarrassment/Regret
  // FASE 10.3.1: Usa thresholds ajustados para verificação de severidade
  let severity: 'info' | 'warning' = 'info';
  const severityThreshold = tensionLevel === 'high' ? 0.12 : 0.15; // Threshold mais baixo em alta tensão
  if (despair >= severityThreshold || grief >= severityThreshold || shame >= severityThreshold || guilt >= severityThreshold || embarrassment >= severityThreshold || regret >= severityThreshold) {
    severity = 'warning';
  }

  // Define cooldown
  ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.primaryEmotion.sadness);

  // FASE 6: Gera feedback baseado na subcategoria e emoção dominante
  const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
  
  let message = `${name}: tom negativo detectado. Considere validar sentimentos e criar espaço para expressão.`;
  let tips: string[] = ['Valide os sentimentos expressos', 'Crie espaço para diálogo', 'Considere fazer uma pausa se necessário'];

  // FASE 9: Mensagens específicas baseadas na emoção dominante (padronizado)
  // Padrão: emoção > threshold && emoção === score && emoção > outras na mesma subcategoria
  if (hasDeepLoss && deepLoss === score) {
    // Luto/Perda profunda é dominante
    const isDespairDominant = despair > tAdjusted.despair && despair === deepLoss && despair > grief;
    const isGriefDominant = grief > tAdjusted.grief && grief === deepLoss && grief > despair;
    
    if (isDespairDominant) {
      message = `${name}: desespero detectado. Momento crítico que requer atenção imediata.`;
      tips = ['Priorize acolhimento', 'Valide o sofrimento profundo', 'Considere suporte profissional se apropriado'];
      severity = despair >= 0.15 ? 'warning' : 'info';
    } else if (isGriefDominant) {
      message = `${name}: luto detectado. Momento de perda profunda que requer espaço e validação.`;
      tips = ['Valide o luto', 'Crie espaço para expressão', 'Respeite o tempo de processamento'];
      severity = grief >= 0.15 ? 'warning' : 'info';
    }
  } else if (hasIsolation && isolation === score) {
    // Isolamento é dominante
    const isLonelinessDominant = loneliness > tAdjusted.loneliness && loneliness === isolation && loneliness > melancholy;
    const isMelancholyDominant = melancholy > tAdjusted.melancholy && melancholy === isolation && melancholy > loneliness;
    
    if (isLonelinessDominant) {
      message = `${name}: solidão detectada. Considere criar conexão e validação.`;
      tips = ['Crie espaço para conexão', 'Valide a solidão', 'Ofereça presença e acolhimento'];
    } else if (isMelancholyDominant) {
      message = `${name}: melancolia detectada. Ambiente de tristeza profunda e reflexiva.`;
      tips = ['Valide a melancolia', 'Crie espaço para expressão', 'Respeite o momento de reflexão'];
    }
  } else if (hasSelfEvaluation && selfEvaluation === score) {
    // Autoavaliação negativa é dominante
    const isRegretDominant = regret > tAdjusted.regret && regret === selfEvaluation && regret > Math.max(shame, guilt, embarrassment);
    const isShameDominant = shame > tAdjusted.shame && shame === selfEvaluation && shame > Math.max(regret, guilt, embarrassment);
    const isGuiltDominant = guilt > tAdjusted.guilt && guilt === selfEvaluation && guilt > Math.max(regret, shame, embarrassment);
    const isEmbarrassmentDominant = embarrassment > tAdjusted.embarrassment && embarrassment === selfEvaluation && embarrassment > Math.max(regret, shame, guilt);
    
    if (isRegretDominant) {
      message = `${name}: arrependimento detectado. Considere criar espaço para expressão e validação.`;
      tips = ['Valide o arrependimento', 'Evite julgamentos', 'Ofereça perspectiva se apropriado'];
      if (severity !== 'warning') {
        severity = regret >= 0.15 ? 'warning' : 'info';
      }
    } else if (isShameDominant) {
      message = `${name}: vergonha detectada. Ambiente precisa de acolhimento e validação.`;
      tips = ['Crie um espaço seguro', 'Valide sem julgamento', 'Evite minimizar o sentimento'];
      if (severity !== 'warning') {
        severity = shame >= 0.15 ? 'warning' : 'info';
      }
    } else if (isGuiltDominant) {
      message = `${name}: culpa detectada. Considere criar espaço para expressão e validação.`;
      tips = ['Valide o sentimento', 'Evite julgamentos', 'Ofereça perspectiva se apropriado'];
      if (severity !== 'warning') {
        severity = guilt >= 0.15 ? 'warning' : 'info';
      }
    } else if (isEmbarrassmentDominant) {
      message = `${name}: constrangimento detectado. Considere criar um ambiente mais acolhedor.`;
      tips = ['Reduza a pressão', 'Crie um espaço seguro', 'Valide o desconforto'];
      if (severity !== 'warning') {
        severity = embarrassment >= 0.15 ? 'warning' : 'info';
      }
    }
  } else if (hasDirectSadness && directSadness === score) {
    // Tristeza direta é dominante
    const isSorrowDominant = sorrow > tAdjusted.sorrow && sorrow === directSadness && sorrow > Math.max(sadness, disappointment);
    const isSadnessDominant = sadness > tAdjusted.sadness && sadness === directSadness && sadness > Math.max(sorrow, disappointment);
    const isDisappointmentDominant = disappointment > tAdjusted.disappointment && disappointment === directSadness && disappointment > Math.max(sorrow, sadness);
    
    if (isSorrowDominant) {
      message = `${name}: pesar detectado. Considere validar sentimentos e criar espaço para expressão.`;
      tips = ['Valide o pesar', 'Crie espaço para diálogo', 'Ofereça suporte se apropriado'];
    } else if (isSadnessDominant) {
      message = `${name}: tristeza detectada. Considere validar sentimentos e criar espaço para expressão.`;
      tips = ['Valide a tristeza', 'Crie espaço para diálogo', 'Ofereça suporte se apropriado'];
    } else if (isDisappointmentDominant) {
      message = `${name}: decepção detectada. Considere validar expectativas e criar espaço para expressão.`;
      tips = ['Valide a decepção', 'Reconheça expectativas não atendidas', 'Crie espaço para diálogo'];
    }
  } else if (hasJudgment && judgment === score) {
    // Julgamento é dominante
    if (disapproval > tAdjusted.disapproval && disapproval === judgment) {
      message = `${name}: desaprovação detectada. Considere explorar diferentes perspectivas.`;
      tips = ['Explore diferentes pontos de vista', 'Valide preocupações', 'Evite polarização'];
    }
  }

  // FASE 10.3.2: Contextualiza mensagem baseado em histórico
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 60_000, now);
    const contextualized = contextualizeMessage(message, tips, {
      recentEmotions,
      currentEmotionType: 'tristeza',
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

