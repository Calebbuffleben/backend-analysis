import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';
import { calculateTensionLevel, getHostilityThreshold, getThreatThreshold, getThresholdByTrend, hasConsistentTrend, hasRecentOverlap, calculateEmotionTrend } from '../context/context-adjustments';

/**
 * Detecta hostilidade através de emoções primárias.
 * 
 * FASE 2: Expandido para detectar múltiplas emoções de hostilidade e ameaça.
 * FASE 9: Padronizada lógica de detecção de emoção dominante.
 * FASE 10.2: Validações baseadas em subcategorias (ativa vs medo/ameaça).
 * FASE 10.3.1: Thresholds dinâmicos baseados em tensão emocional.
 * 
 * Regras A2E2:
 * - Detecta emoções de hostilidade ativa OU medo/ameaça acima dos thresholds
 * - Usa subcategorias:
 *   - Hostilidade Ativa: anger, disgust, distress, rage, contempt
 *   - Medo/Ameaça: fear, horror, terror, anxiety
 * - Usa Math.max() por subcategoria, depois Math.max() entre subcategorias
 * - Requer speech coverage >= 18%
 * - Cooldown de 30s
 * 
 * Validações contextuais:
 * - Hostilidade ativa: arousal >= 0.2, valence negativo
 * - Medo/Ameaça: arousal >= 0.15 (mais baixo, medo pode ter menos energia)
 * 
 * Severidade:
 * - Terror/Horror/Rage: sempre 'warning'
 * - Fear/Anxiety: 'warning' se > 0.10, senão 'info'
 * - Outras: baseado em arousal (>= 0.3 = 'warning')
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se hostilidade detectada, null caso contrário
 */
export function detectHostility(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechPrimary = A2E2_THRESHOLDS.gates.minSpeechPrimary;

  // Validações básicas
  const w = ctx.window(state, now, longWindowMs);
  // ETAPA 1: Mínimo ajustado de 10 para 6 amostras (janela de 10s, taxa ~1 amostra/s)
  // 6 amostras = 60% da janela esperada, permite detecção precoce de emoções primárias
  if (w.samplesCount < 6) return null;
  if (state.ema.emotions.size === 0) return null;

  // Verifica speech coverage
  const speechCoverage = w.samplesCount > 0 ? w.speechCount / w.samplesCount : 0;
  if (speechCoverage < minSpeechPrimary) return null;

  // FASE 2: Obtém valores de emoções por subcategoria
  // Hostilidade Ativa: anger, disgust, distress, rage, contempt
  const anger = state.ema.emotions.get('anger') ?? 0;
  const disgust = state.ema.emotions.get('disgust') ?? 0;
  const distress = state.ema.emotions.get('distress') ?? 0;
  const rage = state.ema.emotions.get('rage') ?? 0;
  const contempt = state.ema.emotions.get('contempt') ?? 0;
  const activeHostilityScore = Math.max(anger, disgust, distress, rage, contempt);

  // Medo/Ameaça: fear, horror, terror, anxiety
  const fear = state.ema.emotions.get('fear') ?? 0;
  const horror = state.ema.emotions.get('horror') ?? 0;
  const terror = state.ema.emotions.get('terror') ?? 0;
  const anxiety = state.ema.emotions.get('anxiety') ?? 0;
  const threatScore = Math.max(fear, horror, terror, anxiety);

  // Usa o maior score entre as duas subcategorias
  const hostilityScore = Math.max(activeHostilityScore, threatScore);

  // FASE 2: Obtém arousal e valence para cálculos
  const arousal = state.ema.arousal;
  const valence = state.ema.valence;

  // FASE 10.3.1: Calcula nível de tensão e ajusta thresholds dinamicamente
  const tensionLevel = ctx.getTensionLevel ? ctx.getTensionLevel(state) : calculateTensionLevel(arousal, valence);
  
  // FASE 10.3.1: Calcula tendência temporal para cada emoção principal
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
  
  // Verifica thresholds por subcategoria com ajustes dinâmicos
  // Verifica se qualquer emoção na subcategoria está acima do seu threshold específico
  const t = A2E2_THRESHOLDS.primary.hostility;
  
  // CORREÇÃO: Threshold mínimo absoluto aumentado para prevenir falsos positivos
  // Aumentado de 0.06 para 0.08 - thresholds muito baixos causam muitos falsos positivos
  const MIN_HOSTILITY_THRESHOLD = 0.08; // 8% mínimo absoluto (aumentado de 6%)
  
  // Aplica ajustes por tensão primeiro, depois por tendência temporal
  const tAdjusted = {
    // Hostilidade ativa: ajusta thresholds em alta tensão + tendência temporal
    anger: Math.max(MIN_HOSTILITY_THRESHOLD, getThresholdByTrend(getHostilityThreshold(t.anger, tensionLevel), getEmotionTrendValue('anger'), 'negative')),
    disgust: Math.max(MIN_HOSTILITY_THRESHOLD, getThresholdByTrend(getHostilityThreshold(t.disgust, tensionLevel), getEmotionTrendValue('disgust'), 'negative')),
    distress: Math.max(MIN_HOSTILITY_THRESHOLD, getThresholdByTrend(getHostilityThreshold(t.distress, tensionLevel), getEmotionTrendValue('distress'), 'negative')),
    rage: Math.max(MIN_HOSTILITY_THRESHOLD, getThresholdByTrend(getHostilityThreshold(t.rage, tensionLevel), getEmotionTrendValue('rage'), 'negative')),
    contempt: Math.max(MIN_HOSTILITY_THRESHOLD, getThresholdByTrend(getHostilityThreshold(t.contempt, tensionLevel), getEmotionTrendValue('contempt'), 'negative')),
    // Medo/Ameaça: ajusta thresholds em alta tensão (redução menor) + tendência temporal
    fear: Math.max(MIN_HOSTILITY_THRESHOLD, getThresholdByTrend(getThreatThreshold(t.fear, tensionLevel), getEmotionTrendValue('fear'), 'negative')),
    horror: Math.max(MIN_HOSTILITY_THRESHOLD, getThresholdByTrend(getThreatThreshold(t.horror, tensionLevel), getEmotionTrendValue('horror'), 'negative')),
    terror: Math.max(MIN_HOSTILITY_THRESHOLD, getThresholdByTrend(getThreatThreshold(t.terror, tensionLevel), getEmotionTrendValue('terror'), 'negative')),
    anxiety: Math.max(MIN_HOSTILITY_THRESHOLD, getThresholdByTrend(getThreatThreshold(t.anxiety, tensionLevel), getEmotionTrendValue('anxiety'), 'negative')),
  };
  
  const hasActiveHostility = 
    anger > tAdjusted.anger ||
    disgust > tAdjusted.disgust ||
    distress > tAdjusted.distress ||
    rage > tAdjusted.rage ||
    contempt > tAdjusted.contempt;
  const hasThreat = 
    fear > tAdjusted.fear ||
    horror > tAdjusted.horror ||
    terror > tAdjusted.terror ||
    anxiety > tAdjusted.anxiety;

  // Precisa ter pelo menos uma subcategoria acima do threshold
  if (!hasActiveHostility && !hasThreat) {
    return null;
  }

  // FASE 10.3.1: Bloqueio por oscilação rápida
  // Se hostilidade foi detectada 3+ vezes nos últimos 30s, bloqueia para evitar spam
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    const recentHostilityCount = recentEmotions.filter((e) => e.type === 'hostilidade').length;
    if (recentHostilityCount >= 3) {
      return null; // Oscilação rápida detectada, bloqueia para evitar spam
    }
    
    // FASE 10.3.1: Bloqueio por sobreposição recente
    // Se hostilidade similar foi detectada nos últimos 20s e score atual não é > 20% maior, bloqueia
    if (hasRecentOverlap(recentEmotions, 'hostilidade', hostilityScore, 20_000, now)) {
      return null; // Sobreposição recente detectada, bloqueia para evitar spam
    }
    
    // FASE 10.3.1: Validação por tendência consistente
    // Se hostilidade está aumentando consistentemente (3+ detecções consecutivas), reduz threshold adicional
    if (hasConsistentTrend(recentEmotions, 'hostilidade', 30_000, now)) {
      // CORREÇÃO: Aplica redução adicional de 10% para detecção precoce, mas respeita mínimo absoluto
      Object.keys(tAdjusted).forEach((key) => {
        const k = key as keyof typeof tAdjusted;
        tAdjusted[k] = Math.max(MIN_HOSTILITY_THRESHOLD, tAdjusted[k] * 0.9);
      });
    }
  }

  // FASE 2: Validações contextuais por subcategoria
  // (arousal e valence já obtidos acima)

  // CORREÇÃO: Hostilidade ativa requer energia moderada - aumentado de 0.2 para 0.25
  // Aumentado para reduzir falsos positivos de emoções leves
  if (hasActiveHostility && typeof arousal === 'number' && arousal < 0.25) {
    return null; // Hostilidade ativa sem energia suficiente é falso positivo
  }

  // CORREÇÃO: Medo/Ameaça requer energia mínima maior para reduzir falsos positivos
  // Aumentado de 0.15 para 0.25 - ansiedade leve não deve ser detectada como hostilidade
  if (hasThreat && typeof arousal === 'number' && arousal < 0.25) {
    return null; // Medo sem energia suficiente não é hostilidade real
  }

  // CORREÇÃO: Hostilidade ativa geralmente tem valence negativo - validação mais restritiva
  // Reduzido de 0.1 para 0.0 - hostilidade ativa não deve ter tom positivo
  // Mas não bloqueamos se for medo (medo pode ter valence variado)
  if (hasActiveHostility && !hasThreat && typeof valence === 'number' && valence > 0.0) {
    return null; // Hostilidade ativa com tom positivo é contraditório
  }

  // CORREÇÃO: Calcula emoções positivas uma vez para validações
  const joy = state.ema.emotions.get('joy') ?? 0;
  const interest = state.ema.emotions.get('interest') ?? 0;
  const enthusiasm = state.ema.emotions.get('enthusiasm') ?? 0;
  const excitement = state.ema.emotions.get('excitement') ?? 0;
  const amusement = state.ema.emotions.get('amusement') ?? 0;
  const positiveScore = Math.max(joy, interest, enthusiasm, excitement, amusement);

  // CORREÇÃO: Validação de intensidade relativa geral - muito mais restritiva
  // Reduzido de 50% para 40% - se emoções positivas são 40% ou mais da hostilidade, não é hostilidade real
  // Aplicado antes das validações específicas para evitar cálculos duplicados
  if (positiveScore > hostilityScore * 0.4) {
    return null; // Emoções positivas dominam, não é hostilidade
  }
  
  // CORREÇÃO ADICIONAL: Se emoções positivas são moderadas (>= 0.08), bloqueia hostilidade baixa/moderada
  // Aumentado de 0.06 para 0.08 para ser menos restritivo e permitir mais detecções legítimas
  if (positiveScore >= 0.08 && hostilityScore < 0.15) {
    return null; // Emoções positivas moderadas bloqueiam hostilidade baixa/moderada
  }

  // CORREÇÃO: Validação de score mínimo absoluto para hostilidade - mais restritiva
  // Aumentado de 0.10 para 0.12 - hostilidade muito baixa não deve gerar feedback
  // Mas permite se há emoção dominante específica (será verificado depois)
  if (hostilityScore < 0.12) {
    // Requer arousal muito alto para hostilidade leve ser considerada real
    if (typeof arousal === 'number' && arousal < 0.35) {
      return null; // Hostilidade muito baixa sem arousal alto não é hostilidade real
    }
    // Requer valence muito negativo para hostilidade leve ser considerada real
    if (typeof valence === 'number' && valence > -0.15) {
      return null; // Hostilidade muito baixa sem tom negativo suficiente não é hostilidade real
    }
    // Se há emoções positivas moderadas, não é hostilidade
    // Aumentado de 0.04 para 0.05 para ser menos restritivo
    if (positiveScore > 0.05) {
      return null; // Emoções positivas moderadas bloqueiam hostilidade muito baixa
    }
  }

  // CORREÇÃO: Validação específica para anxiety - ansiedade leve não é hostilidade
  // Se apenas anxiety está acima do threshold, requer validações mais estritas
  if (hasThreat && !hasActiveHostility && anxiety > tAdjusted.anxiety) {
    // Anxiety com valence positivo não é hostilidade (nervosismo positivo)
    if (typeof valence === 'number' && valence > 0.0) {
      return null; // Ansiedade positiva não é hostilidade
    }
    // Se há emoções positivas fortes, não é hostilidade (já calculado acima)
    if (positiveScore > anxiety * 0.7) {
      return null; // Emoções positivas dominam sobre ansiedade leve
    }
  }

  // Verifica cooldowns
  const type = 'hostilidade';
  if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) {
    return null;
  }

  // FASE 2: Gradação de severidade baseada em emoção e arousal
  let severity: 'info' | 'warning' = 'info';

  // Terror, Horror e Rage são sempre 'warning' (emoções extremas)
  if (terror > tAdjusted.terror || horror > tAdjusted.horror || rage > tAdjusted.rage) {
    severity = 'warning';
  }
  // Fear e Anxiety: 'warning' se > 0.10, senão 'info'
  else if (fear > 0.10 || anxiety > 0.10) {
    severity = 'warning';
  }
  // Outras emoções: baseado em arousal (>= 0.3 = 'warning')
  else if (typeof arousal === 'number' && arousal >= 0.3) {
    severity = 'warning';
  }

  // Define cooldown
  ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.primaryEmotion.hostility);

  // CORREÇÃO CRÍTICA: Validação adicional muito mais restritiva
  // A mensagem "a conversa esquentou" só deve aparecer quando há hostilidade CLARA e SIGNIFICATIVA
  // Se hostilidade é baixa/moderada, requer validações muito mais estritas ou bloqueia completamente
  
  // Se não há hostilidade ativa clara, requer hostilidade muito mais alta
  if (!hasActiveHostility) {
    // Apenas medo/ameaça: requer score muito mais alto (0.15+) e validações estritas
    if (hostilityScore < 0.15) {
      return null; // Medo/ameaça leve não é hostilidade suficiente
    }
    // Requer arousal alto e valence negativo para medo/ameaça ser considerado hostilidade
    if (typeof arousal === 'number' && arousal < 0.35) {
      return null; // Medo/ameaça sem arousal alto não é hostilidade
    }
    if (typeof valence === 'number' && valence > -0.2) {
      return null; // Medo/ameaça sem tom negativo suficiente não é hostilidade
    }
  } else {
    // Há hostilidade ativa: requer score mínimo de 0.12 para mensagem padrão
    if (hostilityScore < 0.12) {
      return null; // Hostilidade ativa muito baixa não gera mensagem padrão
    }
  }
  
  // CORREÇÃO: Bloqueia mensagem padrão se não há emoção dominante clara E hostilidade é moderada
  // Mensagem padrão só aparece se hostilidade é alta OU há emoção dominante específica
  const hasClearDominantEmotion = 
    (threatScore > activeHostilityScore && (
      terror > tAdjusted.terror && terror === threatScore ||
      horror > tAdjusted.horror && horror === threatScore ||
      fear > tAdjusted.fear && fear === threatScore ||
      anxiety > tAdjusted.anxiety && anxiety === threatScore
    )) ||
    (activeHostilityScore > threatScore && (
      rage > tAdjusted.rage && rage === activeHostilityScore ||
      contempt > tAdjusted.contempt && contempt === activeHostilityScore
    ));
  
  // Se não há emoção dominante clara, requer hostilidade mais alta para mensagem padrão
  if (!hasClearDominantEmotion && hostilityScore < 0.15) {
    return null; // Hostilidade moderada sem emoção dominante não gera mensagem padrão
  }

  // FASE 2: Gera feedback baseado na subcategoria dominante
  const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
  
  // CORREÇÃO: Inicializa mensagem padrão e flag de emoção específica
  let message = `${name}: a conversa esquentou. Considere validar o ponto do outro antes de prosseguir.`;
  let tips: string[] = ['Respire fundo', 'Use frases como "Entendo seu ponto..."', 'Evite interrupções agora'];
  let hasSpecificEmotion = false; // Flag para indicar se há emoção dominante específica
  let useDefaultMessage = false; // Flag para indicar se deve usar mensagem padrão
  
  // FASE 9: Mensagens específicas baseadas na emoção dominante (padronizado)
  // ORDEM DE PRIORIDADE: Verifica emoções específicas PRIMEIRO, na ordem de intensidade
  // Padrão: emoção > threshold && emoção === score && emoção > outras na mesma categoria
  
  if (threatScore > activeHostilityScore) {
    // Medo/Ameaça é dominante - verifica em ordem de prioridade (mais intenso primeiro)
    // Terror > Horror > Fear > Anxiety
    const isTerrorDominant = terror > tAdjusted.terror && terror === threatScore && terror >= Math.max(fear, horror, anxiety);
    const isHorrorDominant = !isTerrorDominant && horror > tAdjusted.horror && horror === threatScore && horror >= Math.max(fear, terror, anxiety);
    const isFearDominant = !isTerrorDominant && !isHorrorDominant && fear > tAdjusted.fear && fear === threatScore && fear >= Math.max(horror, terror, anxiety);
    const isAnxietyDominant = !isTerrorDominant && !isHorrorDominant && !isFearDominant && anxiety > tAdjusted.anxiety && anxiety === threatScore && anxiety >= Math.max(fear, horror, terror);
    
    if (isTerrorDominant) {
      message = `${name}: pânico extremo detectado. Priorize acalmar o ambiente.`;
      tips = ['Crie um espaço seguro', 'Valide o medo expresso', 'Reduza a pressão imediatamente'];
      hasSpecificEmotion = true;
    } else if (isHorrorDominant) {
      message = `${name}: horror detectado. Ambiente precisa de acalmação urgente.`;
      tips = ['Crie um espaço seguro', 'Valide o sentimento', 'Considere fazer uma pausa'];
      hasSpecificEmotion = true;
    } else if (isFearDominant) {
      message = `${name}: medo detectado. Considere criar um ambiente mais seguro.`;
      tips = ['Valide o medo expresso', 'Crie um espaço seguro', 'Reduza a pressão'];
      hasSpecificEmotion = true;
    } else if (isAnxietyDominant) {
      // Ansiedade: mensagem diferenciada por intensidade
      if (anxiety < 0.15) {
        message = `${name}: parece haver alguma tensão ou ansiedade. Considere criar um ambiente mais acolhedor.`;
        tips = ['Valide a ansiedade', 'Reduza a pressão', 'Crie um espaço seguro'];
        severity = 'info';
      } else {
        message = `${name}: ansiedade detectada. Considere reduzir a pressão.`;
        tips = ['Valide a ansiedade', 'Reduza a pressão', 'Crie um ambiente mais acolhedor'];
      }
      hasSpecificEmotion = true;
    }
  } else if (activeHostilityScore > threatScore) {
    // Hostilidade ativa é dominante - verifica em ordem de prioridade (mais intenso primeiro)
    // Rage > Contempt > Anger/Disgust/Distress
    const isRageDominant = rage > tAdjusted.rage && rage === activeHostilityScore && rage >= Math.max(anger, disgust, distress, contempt);
    const isContemptDominant = !isRageDominant && contempt > tAdjusted.contempt && contempt === activeHostilityScore && contempt >= Math.max(anger, disgust, distress, rage);
    
    if (isRageDominant) {
      message = `${name}: raiva explosiva detectada. Priorize desescalar a situação.`;
      tips = ['Não reaja com raiva', 'Respire fundo', 'Considere fazer uma pausa'];
      hasSpecificEmotion = true;
    } else if (isContemptDominant) {
      message = `${name}: desprezo detectado. Considere validar o ponto do outro.`;
      tips = ['Evite julgamentos', 'Valide diferentes perspectivas', 'Mantenha respeito'];
      hasSpecificEmotion = true;
    }
  }
  
  // Se não há emoção dominante específica, verifica se deve usar mensagem padrão
  if (!hasSpecificEmotion) {
    // CORREÇÃO CRÍTICA: Mensagem padrão "a conversa esquentou" só deve aparecer em casos muito específicos
    // Requer hostilidade ativa alta (>= 0.15) OU medo/ameaça muito alto (>= 0.15) com validações estritas
    if (hasActiveHostility && hostilityScore >= 0.15) {
      useDefaultMessage = true;
    } else if (hasThreat && !hasActiveHostility && hostilityScore >= 0.15) {
      // Medo/ameaça muito alto pode usar mensagem padrão APENAS se passar validações muito estritas
      // Requer arousal muito alto (>= 0.4) e valence muito negativo (<= -0.25)
      if (typeof arousal === 'number' && arousal >= 0.4 && typeof valence === 'number' && valence <= -0.25) {
        useDefaultMessage = true;
      }
    }
  }
  
  // CORREÇÃO CRÍTICA: Só bloqueia se NÃO há emoção dominante específica E não passou nas validações para mensagem padrão
  // Se há emoção dominante específica (terror, horror, fear, anxiety, rage, contempt), SEMPRE permite o feedback
  // Isso previne que hostilidade moderada sem emoção específica gere feedback, mas permite emoções específicas
  if (!hasSpecificEmotion && !useDefaultMessage) {
    return null; // Sem emoção dominante específica E sem validação para mensagem padrão = não gera feedback
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
