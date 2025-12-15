import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';
import { hasRecentOverlap } from '../context/context-adjustments';

/**
 * Detecta estados mentais contextuais através de emoções primárias.
 * 
 * FASE 7: Expandido com 11 novas emoções (curiosity, anticipation, hope, relief, satisfaction,
 * calmness, contentment, interest, confusion, doubt, boredom).
 * FASE 9: Padronizada lógica de detecção de emoção dominante.
 * FASE 10: Validações contextuais cruzadas refinadas e abrangentes.
 * FASE 10.1: Validações bidirecionais, combinações e níveis graduais de bloqueio.
 * FASE 10.2: Validações baseadas em intensidade relativa e subcategorias.
 * FASE 10.3.1: Bloqueio por oscilação rápida.
 * 
 * Regras A2E2:
 * - Detecta múltiplos estados mentais contextuais acima dos thresholds
 * - Usa subcategorias com thresholds variados:
 *   - Foco: concentration, contemplation
 *   - Desconforto social: awkwardness, envy
 *   - Sofrimento: pain
 *   - Autoafirmação: pride
 *   - Insight: realization
 *   - Memória afetiva: nostalgia
 *   - Motivação: desire
 *   - Quebra de expectativa: surprise
 *   - Estado basal: neutral
 *   - Curiosidade: curiosity, anticipation
 *   - Esperança: hope
 *   - Tranquilidade: relief, satisfaction, calmness, contentment
 *   - Interesse: interest
 *   - Incerteza: confusion, doubt
 *   - Baixa energia: boredom
 * - Requer speech coverage >= 18%
 * - Cooldown de 60s (moderado, estados contextuais variados)
 * 
 * Validações contextuais:
 * - Bloqueio por emoções extremas: rage, contempt, terror, horror > 0.15
 * 
 * Severidade:
 * - Pain muito alto (> 0.15): sempre 'warning'
 * - Awkwardness muito alto (> 0.12): 'warning'
 * - Outras: 'info' (estados mentais não são urgentes)
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se estado mental detectado, null caso contrário
 */
export function detectMentalState(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechPrimary = A2E2_THRESHOLDS.gates.minSpeechPrimary;

  // FASE 10.3.1: Bloqueio por oscilação rápida
  // Se estado mental foi detectado 3+ vezes nos últimos 30s, bloqueia para evitar spam
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    const recentMentalStateCount = recentEmotions.filter((e) => e.type === 'estado_mental').length;
    if (recentMentalStateCount >= 3) {
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
  // Estado mental pode coexistir com várias emoções, mas hostilidade extrema prevalece
  const rage = state.ema.emotions.get('rage') ?? 0;
  const contempt = state.ema.emotions.get('contempt') ?? 0;
  const terror = state.ema.emotions.get('terror') ?? 0;
  const horror = state.ema.emotions.get('horror') ?? 0;

  // Bloqueios absolutos apenas para emoções extremas
  // Estados mentais podem coexistir com outras emoções, mas não com extremos
  if (rage > 0.15 || contempt > 0.15 || terror > 0.15 || horror > 0.15) {
    return null; // Emoções extremas prevalecem sobre estados mentais contextuais
  }

  // FASE 10: Validações contextuais cruzadas - hostilidade moderada-alta bloqueia estados neutros
  const anger = state.ema.emotions.get('anger') ?? 0;
  const disgust = state.ema.emotions.get('disgust') ?? 0;
  const distress = state.ema.emotions.get('distress') ?? 0;
  const fear = state.ema.emotions.get('fear') ?? 0;
  const anxiety = state.ema.emotions.get('anxiety') ?? 0;
  // Hostilidade moderada-alta (0.10-0.15) bloqueia estados mentais neutros/positivos
  if (rage > 0.10 || contempt > 0.10 || anger > 0.10 || disgust > 0.10 || distress > 0.10) {
    return null; // Hostilidade moderada-alta prevalece sobre estados mentais contextuais
  }
  if (terror > 0.10 || horror > 0.10 || fear > 0.10 || anxiety > 0.10) {
    return null; // Medo/ameaça moderada-alta prevalece sobre estados mentais contextuais
  }

  // FASE 10: Validações contextuais cruzadas - tristeza muito alta bloqueia estados neutros
  const despair = state.ema.emotions.get('despair') ?? 0;
  const grief = state.ema.emotions.get('grief') ?? 0;
  const sorrow = state.ema.emotions.get('sorrow') ?? 0;
  if (despair > 0.12 || grief > 0.12 || sorrow > 0.12) {
    return null; // Tristeza muito profunda prevalece sobre estados mentais contextuais
  }

  // FASE 10: Validações contextuais cruzadas - frustração muito alta bloqueia estados neutros
  const frustration = state.ema.emotions.get('frustration') ?? 0;
  if (frustration > 0.12) {
    return null; // Frustração muito alta prevalece sobre estados mentais contextuais
  }

  // FASE 10.1: Obtém emoções positivas para validações específicas
  const curiosity = state.ema.emotions.get('curiosity') ?? 0;
  const hope = state.ema.emotions.get('hope') ?? 0;
  const anticipation = state.ema.emotions.get('anticipation') ?? 0;
  const sadness = state.ema.emotions.get('sadness') ?? 0;
  const hasPositiveMentalState = curiosity > 0.09 || hope > 0.10 || anticipation > 0.09;
  
  // FASE 10.1: Validações bidirecionais - hostilidade moderada bloqueia estados mentais positivos
  // Nível 2 - Bloqueio forte: hostilidade moderada (> 0.08) bloqueia estados mentais positivos
  if (hasPositiveMentalState && (rage > 0.08 || anger > 0.08 || contempt > 0.08)) {
    return null; // Hostilidade moderada prevalece sobre estados mentais positivos
  }

  // FASE 10.1: Validações baseadas em combinações - hostilidade + frustração
  // Combinação de hostilidade moderada + frustração moderada bloqueia estados mentais positivos
  if (hasPositiveMentalState && (rage > 0.06 || anger > 0.06 || contempt > 0.06) && frustration > 0.08) {
    return null; // Combinação hostilidade + frustração prevalece sobre estados mentais positivos
  }

  // FASE 10.1: Validações baseadas em combinações - tristeza + frustração
  // Combinação de tristeza moderada + frustração moderada bloqueia estados mentais positivos
  if (hasPositiveMentalState && (sadness > 0.08 || despair > 0.08 || grief > 0.08 || sorrow > 0.08) && frustration > 0.08) {
    return null; // Combinação tristeza + frustração prevalece sobre estados mentais positivos
  }

  // FASE 10.1: Validações baseadas em combinações - hostilidade + tristeza
  // Combinação de hostilidade moderada + tristeza moderada bloqueia estados mentais positivos
  if (hasPositiveMentalState && (rage > 0.06 || anger > 0.06 || contempt > 0.06) && (sadness > 0.08 || despair > 0.08 || grief > 0.08 || sorrow > 0.08)) {
    return null; // Combinação hostilidade + tristeza prevalece sobre estados mentais positivos
  }

  // FASE 10.1: Validações graduais para medo/ameaça - medo moderado bloqueia estados mentais positivos
  // Medo/ameaça moderada (> 0.08) bloqueia estados mentais positivos
  if (hasPositiveMentalState && (terror > 0.08 || horror > 0.08 || fear > 0.08 || anxiety > 0.08)) {
    return null; // Medo/ameaça moderada prevalece sobre estados mentais positivos
  }

  // FASE 7: Obtém valores de emoções por subcategoria
  const concentration = state.ema.emotions.get('concentration') ?? 0;
  const contemplation = state.ema.emotions.get('contemplation') ?? 0;
  const awkwardness = state.ema.emotions.get('awkwardness') ?? 0;
  const envy = state.ema.emotions.get('envy') ?? 0;
  const pain = state.ema.emotions.get('pain') ?? 0;
  const pride = state.ema.emotions.get('pride') ?? 0;
  const realization = state.ema.emotions.get('realization') ?? 0;
  const nostalgia = state.ema.emotions.get('nostalgia') ?? 0;
  const desire = state.ema.emotions.get('desire') ?? 0;
  const surprise = state.ema.emotions.get('surprise') ?? 0;
  const neutral = state.ema.emotions.get('neutral') ?? 0;
  // FASE 7: Novas emoções (curiosity, hope, anticipation já obtidos acima)
  const relief = state.ema.emotions.get('relief') ?? 0;
  const satisfaction = state.ema.emotions.get('satisfaction') ?? 0;
  const calmness = state.ema.emotions.get('calmness') ?? 0;
  const contentment = state.ema.emotions.get('contentment') ?? 0;
  const interest = state.ema.emotions.get('interest') ?? 0;
  const confusion = state.ema.emotions.get('confusion') ?? 0;
  const doubt = state.ema.emotions.get('doubt') ?? 0;
  const boredom = state.ema.emotions.get('boredom') ?? 0;

  // FASE 7: Calcula scores por subcategoria
  const t = A2E2_THRESHOLDS.primary.mentalState;
  const focus = Math.max(concentration, contemplation);
  const socialDiscomfort = Math.max(awkwardness, envy);
  const suffering = pain;
  const selfAffirmation = pride;
  const insight = realization;
  const affectiveMemory = nostalgia;
  const motivation = desire;
  const expectationBreak = surprise;
  const baseline = neutral;
  // FASE 7: Novas subcategorias
  const curiosityState = Math.max(curiosity, anticipation);
  const hopeState = hope;
  const tranquility = Math.max(relief, satisfaction, calmness, contentment);
  const interestState = interest;
  const uncertainty = Math.max(confusion, doubt);
  const lowEnergy = boredom;

  // FASE 7: Verifica thresholds por subcategoria
  const hasFocus = focus > t.concentration;
  const hasSocialDiscomfort = socialDiscomfort > t.awkwardness;
  const hasSuffering = suffering > t.pain;
  const hasSelfAffirmation = selfAffirmation > t.pride;
  const hasInsight = insight > t.realization;
  const hasAffectiveMemory = affectiveMemory > t.nostalgia;
  const hasMotivation = motivation > t.desire;
  const hasExpectationBreak = expectationBreak > t.surprise;
  const hasBaseline = baseline > t.neutral;
  const hasCuriosity = curiosityState > t.curiosity;
  const hasHope = hopeState > t.hope;
  const hasTranquility = tranquility > t.relief;
  const hasInterest = interestState > t.interest;
  const hasUncertainty = uncertainty > t.confusion;
  const hasLowEnergy = lowEnergy > t.boredom;

  // Precisa ter pelo menos uma subcategoria acima do threshold
  if (
    !hasFocus &&
    !hasSocialDiscomfort &&
    !hasSuffering &&
    !hasSelfAffirmation &&
    !hasInsight &&
    !hasAffectiveMemory &&
    !hasMotivation &&
    !hasExpectationBreak &&
    !hasBaseline &&
    !hasCuriosity &&
    !hasHope &&
    !hasTranquility &&
    !hasInterest &&
    !hasUncertainty &&
    !hasLowEnergy
  ) {
    return null;
  }

  // FASE 7: Usa o maior score entre todas as subcategorias
  const score = Math.max(
    focus,
    socialDiscomfort,
    suffering,
    selfAffirmation,
    insight,
    affectiveMemory,
    motivation,
    expectationBreak,
    baseline,
    curiosityState,
    hopeState,
    tranquility,
    interestState,
    uncertainty,
    lowEnergy,
  );

  // FASE 10.2: Validações baseadas em intensidade relativa para Estado Mental
  // Calcula scores de emoções negativas para comparação
  const activeHostilityScore = Math.max(rage, anger, contempt, disgust, distress);
  const threatScore = Math.max(terror, horror, fear, anxiety);
  const hostilityScore = Math.max(activeHostilityScore, threatScore);
  const deepSadnessScore = Math.max(despair, grief, sorrow);
  const disappointment = state.ema.emotions.get('disappointment') ?? 0;
  const directSadnessScore = Math.max(sadness, disappointment);
  const sadnessScore = Math.max(deepSadnessScore, directSadnessScore);

  // Estados mentais positivos (curiosity, hope, tranquility) são mais sensíveis
  const hasPositiveState = hasCuriosity || hasHope || hasTranquility;
  if (hasPositiveState) {
    // Bloqueia estados positivos se hostilidade/tristeza/frustração é 30% maior
    if (hostilityScore > score * 1.3 || sadnessScore > score * 1.3 || frustration > score * 1.3) {
      return null; // Emoções negativas muito maiores que estados positivos prevalecem
    }
  }

  // Estados mentais neutros (focus, baseline, interest) são menos sensíveis
  const hasNeutralState = hasFocus || hasBaseline || hasInterest;
  if (hasNeutralState && !hasPositiveState) {
    // Bloqueia estados neutros se hostilidade/tristeza/frustração é 40% maior
    if (hostilityScore > score * 1.4 || sadnessScore > score * 1.4 || frustration > score * 1.4) {
      return null; // Emoções negativas muito maiores que estados neutros prevalecem
    }
  }

  // FASE 10.2: Validações baseadas em subcategorias específicas
  // Estados positivos (curiosity, hope) são bloqueados por hostilidade/tristeza moderada
  if (hasCuriosity && (hostilityScore > curiosityState * 0.7 || sadnessScore > curiosityState * 0.7 || frustration > curiosityState * 0.7)) {
    return null; // Emoções negativas moderadas bloqueiam curiosidade
  }
  if (hasHope && (hostilityScore > hopeState * 0.8 || sadnessScore > hopeState * 0.8 || frustration > hopeState * 0.8)) {
    return null; // Emoções negativas moderadas bloqueiam esperança
  }

  // Tranquilidade (relief, satisfaction) é mais resistente (resultado de resolução)
  if (hasTranquility && (hostilityScore > tranquility * 0.9 || sadnessScore > tranquility * 0.9 || frustration > tranquility * 0.9)) {
    return null; // Emoções negativas altas bloqueiam tranquilidade
  }

  // FASE 10.3.1: Bloqueio por sobreposição recente
  // Se estado mental similar foi detectado nos últimos 20s e score atual não é > 20% maior, bloqueia
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    if (hasRecentOverlap(recentEmotions, 'estado_mental', score, 20_000, now)) {
      return null; // Sobreposição recente detectada, bloqueia para evitar spam
    }
  }

  // Verifica cooldowns
  const type = 'estado_mental';
  if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) {
    return null;
  }

  // FASE 7: Gradação de severidade baseada em subcategoria
  // Pain e awkwardness extremos são mais preocupantes
  let severity: 'info' | 'warning' = 'info';
  if (pain >= 0.15 || awkwardness >= 0.12) {
    severity = 'warning';
  }

  // Define cooldown
  ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.primaryEmotion.mentalState);

  // FASE 7: Gera feedback baseado na subcategoria e emoção dominante
  const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
  let message = `${name}: estado mental contextual detectado.`;
  let tips: string[] = [];

  // FASE 9: Mensagens específicas baseadas na emoção dominante (padronizado)
  // Padrão: emoção > threshold && emoção === score && emoção > outras na mesma subcategoria
  // Ordem de prioridade: sofrimento > desconforto social > baixa energia > incerteza > outros
  if (hasSuffering && suffering === score) {
    // Sofrimento é único na subcategoria, não precisa de comparação
    message = `${name}: sofrimento detectado. Considere criar espaço para expressão.`;
    tips = ['Valide o sofrimento expresso', 'Ofereça suporte se apropriado'];
  } else if (hasSocialDiscomfort && socialDiscomfort === score) {
    const isAwkwardnessDominant = awkwardness > t.awkwardness && awkwardness === socialDiscomfort && awkwardness > envy;
    const isEnvyDominant = envy > t.envy && envy === socialDiscomfort && envy > awkwardness;
    
    if (isAwkwardnessDominant) {
      message = `${name}: desconforto social detectado. Considere facilitar a interação.`;
      tips = ['Crie um ambiente mais acolhedor', 'Facilite a participação', 'Reduza a pressão'];
    } else if (isEnvyDominant) {
      message = `${name}: inveja detectada. Considere criar espaço para validação.`;
      tips = ['Valide sentimentos', 'Crie espaço para expressão', 'Evite comparações'];
    } else {
      message = `${name}: desconforto social detectado. Considere facilitar a interação.`;
      tips = ['Crie um ambiente mais acolhedor', 'Facilite a participação'];
    }
  } else if (hasLowEnergy && lowEnergy === score) {
    // Baixa energia é único na subcategoria (boredom), não precisa de comparação
    if (boredom > t.boredom && boredom === lowEnergy) {
      message = `${name}: tédio detectado. Considere variar a dinâmica.`;
      tips = ['Varie a dinâmica', 'Engaje de forma diferente', 'Considere fazer uma pausa'];
    }
  } else if (hasUncertainty && uncertainty === score) {
    const isConfusionDominant = confusion > t.confusion && confusion === uncertainty && confusion > doubt;
    const isDoubtDominant = doubt > t.doubt && doubt === uncertainty && doubt > confusion;
    
    if (isConfusionDominant) {
      message = `${name}: confusão detectada. Considere esclarecer pontos.`;
      tips = ['Esclareça pontos confusos', 'Faça perguntas abertas', 'Valide a confusão'];
    } else if (isDoubtDominant) {
      message = `${name}: dúvida detectada. Considere explorar e validar.`;
      tips = ['Explore a dúvida', 'Valide preocupações', 'Ofereça clareza'];
    }
  } else if (hasCuriosity && curiosityState === score) {
    const isCuriosityDominant = curiosity > t.curiosity && curiosity === curiosityState && curiosity > anticipation;
    const isAnticipationDominant = anticipation > t.anticipation && anticipation === curiosityState && anticipation > curiosity;
    
    if (isCuriosityDominant) {
      message = `${name}: curiosidade detectada. Bom momento para explorar e aprender.`;
      tips = ['Aproveite a curiosidade', 'Explore temas interessantes', 'Faça perguntas abertas'];
    } else if (isAnticipationDominant) {
      message = `${name}: antecipação detectada. Ambiente de expectativa positiva.`;
      tips = ['Aproveite a antecipação', 'Mantenha o engajamento', 'Prepare para o que vem'];
    }
  } else if (hasHope && hopeState === score) {
    // Esperança é único na subcategoria, não precisa de comparação
    if (hope > t.hope && hope === hopeState) {
      message = `${name}: esperança detectada. Ambiente positivo e otimista.`;
      tips = ['Reconheça a esperança', 'Mantenha o tom positivo', 'Aproveite o momento'];
    }
  } else if (hasTranquility && tranquility === score) {
    const isReliefDominant = relief > t.relief && relief === tranquility && relief > Math.max(satisfaction, calmness, contentment);
    const isSatisfactionDominant = satisfaction > t.satisfaction && satisfaction === tranquility && satisfaction > Math.max(relief, calmness, contentment);
    const isCalmnessDominant = calmness > t.calmness && calmness === tranquility && calmness > Math.max(relief, satisfaction, contentment);
    const isContentmentDominant = contentment > t.contentment && contentment === tranquility && contentment > Math.max(relief, satisfaction, calmness);
    
    if (isReliefDominant) {
      message = `${name}: alívio detectado. Momento de relaxamento após tensão.`;
      tips = ['Reconheça o alívio', 'Aproveite o momento de calma', 'Mantenha o ambiente positivo'];
    } else if (isSatisfactionDominant) {
      message = `${name}: satisfação detectada. Ambiente de contentamento.`;
      tips = ['Reconheça a satisfação', 'Celebre o momento', 'Mantenha o tom positivo'];
    } else if (isCalmnessDominant) {
      message = `${name}: calma detectada. Ambiente tranquilo e sereno.`;
      tips = ['Aproveite a calma', 'Mantenha o ambiente tranquilo', 'Respeite o momento'];
    } else if (isContentmentDominant) {
      message = `${name}: contentamento detectado. Ambiente de satisfação leve.`;
      tips = ['Reconheça o contentamento', 'Mantenha o tom positivo', 'Aproveite o momento'];
    }
  } else if (hasInterest && interestState === score) {
    // Interesse é único na subcategoria, não precisa de comparação
    if (interest > t.interest && interest === interestState) {
      message = `${name}: interesse detectado. Bom momento para engajamento.`;
      tips = ['Aproveite o interesse', 'Explore temas relevantes', 'Mantenha o engajamento'];
    }
  } else if (hasFocus && focus === score) {
    const isConcentrationDominant = concentration > t.concentration && concentration === focus && concentration > contemplation;
    const isContemplationDominant = contemplation > t.contemplation && contemplation === focus && contemplation > concentration;
    
    if (isConcentrationDominant) {
      message = `${name}: concentração detectada. Bom momento para trabalho profundo.`;
      tips = ['Aproveite o momento de foco', 'Evite interrupções desnecessárias', 'Respeite o foco'];
    } else if (isContemplationDominant) {
      message = `${name}: contemplação detectada. Momento de reflexão profunda.`;
      tips = ['Respeite o momento de reflexão', 'Evite interrupções', 'Aproveite para insights'];
    }
  } else if (hasInsight && insight === score) {
    // Insight é único na subcategoria (realization), não precisa de comparação
    if (realization > t.realization && realization === insight) {
      message = `${name}: insight ou realização detectada. Considere explorar o momento.`;
      tips = ['Explore o insight compartilhado', 'Faça perguntas abertas', 'Aproveite o momento'];
    }
  } else if (hasSelfAffirmation && selfAffirmation === score) {
    // Autoafirmação é único na subcategoria (pride), não precisa de comparação
    if (pride > t.pride && pride === selfAffirmation) {
      message = `${name}: orgulho ou autoafirmação detectada. Reconheça a conquista.`;
      tips = ['Reconheça a conquista', 'Celebre o momento', 'Valide o orgulho'];
    }
  } else if (hasAffectiveMemory && affectiveMemory === score) {
    // Memória afetiva é único na subcategoria (nostalgia), não precisa de comparação
    if (nostalgia > t.nostalgia && nostalgia === affectiveMemory) {
      message = `${name}: nostalgia detectada. Momento de memória afetiva.`;
      tips = ['Valide a nostalgia', 'Crie espaço para compartilhar', 'Respeite o momento'];
    }
  } else if (hasMotivation && motivation === score) {
    // Motivação é único na subcategoria (desire), não precisa de comparação
    if (desire > t.desire && desire === motivation) {
      message = `${name}: desejo ou motivação detectada. Ambiente de propósito.`;
      tips = ['Aproveite a motivação', 'Canalize para objetivos', 'Mantenha o engajamento'];
    }
  } else if (hasExpectationBreak && expectationBreak === score) {
    // Quebra de expectativa é único na subcategoria (surprise), não precisa de comparação
    if (surprise > t.surprise && surprise === expectationBreak) {
      message = `${name}: surpresa detectada. Momento de quebra de expectativa.`;
      tips = ['Valide a surpresa', 'Explore o momento', 'Adapte conforme necessário'];
    }
  } else if (hasBaseline && baseline === score) {
    // Estado basal é único na subcategoria (neutral), não precisa de comparação
    if (neutral > t.neutral && neutral === baseline) {
      message = `${name}: estado neutro detectado. Ambiente equilibrado.`;
      tips = ['Observe o estado emocional', 'Adapte a abordagem conforme necessário'];
    }
  } else {
    tips = ['Observe o estado emocional', 'Adapte a abordagem conforme necessário'];
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

