import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';
import { calculateTensionLevel, getEngagementThreshold, hasRecentOverlap } from '../context/context-adjustments';
import { contextualizeMessage } from '../context/message-contextualizer';

/**
 * Detecta engajamento positivo através de emoções primárias.
 * 
 * FASE 3: Expandido para detectar múltiplas emoções de alta energia positiva.
 * FASE 9: Padronizada lógica de detecção de emoção dominante.
 * FASE 10: Validações contextuais cruzadas refinadas.
 * FASE 10.1: Validações bidirecionais, combinações e níveis graduais de bloqueio.
 * FASE 10.2: Validações baseadas em intensidade relativa e subcategorias.
 * FASE 10.3.1: Thresholds dinâmicos e mensagens contextuais.
 * 
 * Regras A2E2:
 * - Detecta emoções de engajamento moderado, intenso OU lúdico acima dos thresholds
 * - Usa subcategorias:
 *   - Engajamento Moderado: interest, joy, determination, enthusiasm, excitement
 *   - Engajamento Intenso: ecstasy, triumph, awe, admiration
 *   - Engajamento Lúdico: amusement, entrancement
 * - Usa Math.max() por subcategoria, depois Math.max() entre subcategorias
 * - Requer speech coverage >= 18%
 * - Cooldown de 60s (mais longo para evitar spam de elogios)
 * 
 * Validações contextuais:
 * - Bloqueio por hostilidade: todas as emoções de hostilidade e medo/ameaça > 0.05
 * - Bloqueio por prosódica: valence <= -0.3 ou arousal < 0.1
 * - FASE 10: Bloqueio por tristeza muito alta: despair, grief, sorrow > 0.12
 * - FASE 10: Bloqueio por frustração muito alta: frustration > 0.12
 * - FASE 10.1: Bloqueio por hostilidade moderada-alta: rage > 0.08, anger > 0.08, contempt > 0.08
 * - FASE 10.1: Bloqueio por combinação hostilidade + frustração: (rage > 0.06 || anger > 0.06) && frustration > 0.08
 * 
 * Severidade:
 * - Ecstasy/Triumph: sempre 'warning' (exceto se houver emoções negativas moderadas)
 * - Outras: baseado em arousal, valence e emoções negativas
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se engajamento detectado, null caso contrário
 */
export function detectEngagement(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechPrimary = A2E2_THRESHOLDS.gates.minSpeechPrimary;

  // FASE 10.3.1: Bloqueio por oscilação rápida
  // Se engajamento foi detectado 3+ vezes nos últimos 30s, bloqueia para evitar spam
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    const recentEngagementCount = recentEmotions.filter((e) => e.type === 'entusiasmo_alto').length;
    if (recentEngagementCount >= 3) {
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

  // ETAPA 5: Verificações contextuais relaxadas com gradação de severidade
  // Engajamento requer tom positivo e energia moderada, mas permite casos limítrofes com severidade menor
  const valence = state.ema.valence;
  const arousal = state.ema.arousal;
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

  // Bloqueios absolutos (contradições lógicas claras)
  if (typeof valence === 'number' && valence <= -0.3) {
    return null; // Engajamento com tom muito negativo é contraditório
  }
  if (typeof arousal === 'number' && arousal < 0.1) {
    return null; // Engajamento sem energia mínima é contraditório
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
    return null; // Engajamento com hostilidade ou medo significativo é contraditório
  }

  // FASE 10.1: Validações bidirecionais - hostilidade moderada-alta bloqueia engajamento
  // FASE 10.2: Validações baseadas em subcategorias - hostilidade ativa bloqueia mais que medo/ameaça
  // Hostilidade ativa (rage, anger, contempt) bloqueia com threshold mais baixo
  if (rage > 0.08 || anger > 0.08 || contempt > 0.08) {
    return null; // Hostilidade ativa moderada-alta prevalece sobre engajamento
  }
  // Medo/ameaça (terror, horror, fear, anxiety) bloqueia com threshold mais alto (já verificado acima em > 0.08)

  // FASE 10.1: Validações baseadas em combinações - hostilidade + frustração
  // Combinação de hostilidade baixa + frustração moderada também bloqueia
  const frustration = state.ema.emotions.get('frustration') ?? 0;
  if ((rage > 0.06 || anger > 0.06 || contempt > 0.06) && frustration > 0.08) {
    return null; // Combinação hostilidade + frustração prevalece sobre engajamento
  }

  // FASE 10: Validações contextuais cruzadas - tristeza muito alta bloqueia engajamento
  // FASE 10.2: Validações baseadas em subcategorias - tristeza profunda bloqueia mais que tristeza direta
  const despair = state.ema.emotions.get('despair') ?? 0;
  const grief = state.ema.emotions.get('grief') ?? 0;
  const sorrow = state.ema.emotions.get('sorrow') ?? 0;
  const sadness = state.ema.emotions.get('sadness') ?? 0;
  const melancholy = state.ema.emotions.get('melancholy') ?? 0;
  // Tristeza profunda (grief, despair) bloqueia com threshold mais baixo (> 0.10)
  if (grief > 0.10 || despair > 0.10) {
    return null; // Tristeza profunda prevalece sobre engajamento
  }
  // Tristeza muito alta (profunda > 0.12 ou direta > 0.12) bloqueia completamente
  if (despair > 0.12 || grief > 0.12 || sorrow > 0.12) {
    return null; // Tristeza muito profunda prevalece sobre engajamento
  }
  // Tristeza direta moderada-alta (> 0.10) também bloqueia engajamento intenso/lúdico
  // mas permite engajamento moderado com severidade reduzida (será tratado na lógica de severidade)

  // FASE 10: Validações contextuais cruzadas - frustração muito alta bloqueia engajamento
  // (frustration já foi obtido acima para validação de combinação)
  if (frustration > 0.12) {
    return null; // Frustração muito alta prevalece sobre engajamento
  }
  // Frustração moderada (> 0.08) bloqueia engajamento intenso/lúdico, mas permite moderado
  // (será tratado na lógica de severidade)

  // FASE 10.1: Validações baseadas em combinações - tristeza + frustração
  // Combinação de tristeza moderada + frustração moderada também bloqueia
  if ((sadness > 0.08 || despair > 0.08 || grief > 0.08 || sorrow > 0.08) && frustration > 0.08) {
    return null; // Combinação tristeza + frustração prevalece sobre engajamento
  }

  // FASE 10.1: Validações baseadas em combinações - hostilidade + tristeza
  // Combinação de hostilidade baixa + tristeza moderada também bloqueia
  if ((rage > 0.05 || anger > 0.05 || contempt > 0.05) && (sadness > 0.08 || despair > 0.08 || grief > 0.08 || sorrow > 0.08)) {
    return null; // Combinação hostilidade + tristeza prevalece sobre engajamento
  }

  // FASE 10.1: Validações graduais para medo/ameaça - medo moderado-alto bloqueia engajamento
  // Medo/ameaça moderada-alta (> 0.08) bloqueia engajamento (similar a hostilidade)
  if (terror > 0.08 || horror > 0.08 || fear > 0.08 || anxiety > 0.08) {
    return null; // Medo/ameaça moderada-alta prevalece sobre engajamento
  }

  // FASE 3: Obtém valores de emoções por subcategoria
  // Engajamento Moderado: interest, joy, determination, enthusiasm, excitement
  const interest = state.ema.emotions.get('interest') ?? 0;
  const joy = state.ema.emotions.get('joy') ?? 0;
  const determination = state.ema.emotions.get('determination') ?? 0;
  const enthusiasm = state.ema.emotions.get('enthusiasm') ?? 0;
  const excitement = state.ema.emotions.get('excitement') ?? 0;
  const moderateScore = Math.max(interest, joy, determination, enthusiasm, excitement);

  // Engajamento Intenso: ecstasy, triumph, awe, admiration
  const ecstasy = state.ema.emotions.get('ecstasy') ?? 0;
  const triumph = state.ema.emotions.get('triumph') ?? 0;
  const awe = state.ema.emotions.get('awe') ?? 0;
  const admiration = state.ema.emotions.get('admiration') ?? 0;
  const intenseScore = Math.max(ecstasy, triumph, awe, admiration);

  // Engajamento Lúdico: amusement, entrancement
  const amusement = state.ema.emotions.get('amusement') ?? 0;
  const entrancement = state.ema.emotions.get('entrancement') ?? 0;
  const playfulScore = Math.max(amusement, entrancement);

  // Usa o maior score entre as três subcategorias
  const score = Math.max(moderateScore, intenseScore, playfulScore);

  // FASE 10.3.1: Bloqueio por sobreposição recente
  // Se engajamento similar foi detectado nos últimos 20s e score atual não é > 20% maior, bloqueia
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    if (hasRecentOverlap(recentEmotions, 'entusiasmo_alto', score, 20_000, now)) {
      return null; // Sobreposição recente detectada, bloqueia para evitar spam
    }
  }

  // FASE 10.3.1: Calcula nível de tensão e ajusta thresholds dinamicamente
  // (arousal e valence serão obtidos mais abaixo, mas precisamos aqui para calcular tensão)
  const arousalForTension = state.ema.arousal;
  const valenceForTension = state.ema.valence;
  const tensionLevel = ctx.getTensionLevel ? ctx.getTensionLevel(state) : calculateTensionLevel(arousalForTension, valenceForTension);
  
  // Verifica thresholds por subcategoria com ajustes dinâmicos
  const t = A2E2_THRESHOLDS.primary.engagement;
  const tAdjusted = {
    // Engajamento moderado: ajusta em baixa tensão
    interest: getEngagementThreshold(t.interest, tensionLevel),
    joy: getEngagementThreshold(t.joy, tensionLevel),
    determination: getEngagementThreshold(t.determination, tensionLevel),
    enthusiasm: getEngagementThreshold(t.enthusiasm, tensionLevel),
    excitement: getEngagementThreshold(t.excitement, tensionLevel),
    // Engajamento intenso: ajusta em baixa tensão
    ecstasy: getEngagementThreshold(t.ecstasy, tensionLevel),
    triumph: getEngagementThreshold(t.triumph, tensionLevel),
    awe: getEngagementThreshold(t.awe, tensionLevel),
    admiration: getEngagementThreshold(t.admiration, tensionLevel),
    // Engajamento lúdico: ajusta em baixa tensão
    amusement: getEngagementThreshold(t.amusement, tensionLevel),
    entrancement: getEngagementThreshold(t.entrancement, tensionLevel),
  };
  
  const hasModerate = moderateScore > tAdjusted.interest;
  const hasIntense = intenseScore > tAdjusted.ecstasy;
  const hasPlayful = playfulScore > tAdjusted.amusement;

  // Precisa ter pelo menos uma subcategoria acima do threshold
  if (!hasModerate && !hasIntense && !hasPlayful) {
    return null;
  }

  // FASE 10.2: Validações baseadas em intensidade relativa
  // Calcula scores de emoções negativas para comparação
  const activeHostilityScore = Math.max(rage, anger, contempt, disgust, distress);
  const threatScore = Math.max(terror, horror, fear, anxiety);
  const hostilityScore = Math.max(activeHostilityScore, threatScore);
  const deepSadnessScore = Math.max(despair, grief, sorrow);
  const directSadnessScore = Math.max(sadness, melancholy);
  const sadnessScore = Math.max(deepSadnessScore, directSadnessScore);

  // Hostilidade vs Engajamento: bloqueia se hostilidade é 50% maior que engajamento
  if (hostilityScore > score * 1.5) {
    return null; // Hostilidade muito maior que engajamento prevalece
  }

  // Tristeza vs Engajamento: bloqueia se tristeza é 30% maior que engajamento
  if (sadnessScore > score * 1.3) {
    return null; // Tristeza muito maior que engajamento prevalece
  }

  // Frustração vs Engajamento: bloqueia se frustração é 40% maior que engajamento
  if (frustration > score * 1.4) {
    return null; // Frustração muito maior que engajamento prevalece
  }

  // FASE 10.2: Validações baseadas em subcategorias de engajamento
  // Engajamento intenso (ecstasy, triumph) é mais facilmente bloqueado
  if (hasIntense) {
    // Bloqueia engajamento intenso se hostilidade/tristeza/frustração é 80% do engajamento
    if (hostilityScore > intenseScore * 0.8 || sadnessScore > intenseScore * 0.8 || frustration > intenseScore * 0.8) {
      return null; // Emoções negativas moderadas bloqueiam engajamento intenso
    }
  }

  // Engajamento lúdico (amusement, entrancement) é bloqueado por hostilidade moderada
  if (hasPlayful) {
    // Bloqueia engajamento lúdico se hostilidade é 70% do engajamento
    if (hostilityScore > playfulScore * 0.7) {
      return null; // Hostilidade moderada bloqueia engajamento lúdico
    }
  }

  // Engajamento moderado (interest, joy) pode coexistir com emoções negativas baixas
  // mas ainda é bloqueado por validações absolutas acima

  // Verifica cooldowns
  const type = 'entusiasmo_alto';
  if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) {
    return null;
  }

  // FASE 3: Gradação de severidade baseada em emoção e contexto
  let severity: 'info' | 'warning' = 'warning';

  // FASE 10: Tristeza moderada-alta reduz severidade do engajamento
  const hasModerateSadness = sadness > 0.10 || melancholy > 0.10;
  const hasModerateFrustration = frustration > 0.08 && frustration <= 0.12;
  
  // FASE 10.1: Hostilidade baixa reduz severidade do engajamento
  const hasLowHostility = (rage > 0.03 && rage <= 0.05) || (anger > 0.03 && anger <= 0.05) || (contempt > 0.03 && contempt <= 0.05);

  // FASE 10.2: Redução de severidade baseada em intensidade relativa
  // Se hostilidade/tristeza/frustração é 60-80% do engajamento, reduz severidade mas não bloqueia
  const hasModerateRelativeHostility = hostilityScore > score * 0.6 && hostilityScore <= score * 0.8;
  const hasModerateRelativeSadness = sadnessScore > score * 0.6 && sadnessScore <= score * 0.8;
  const hasModerateRelativeFrustration = frustration > score * 0.6 && frustration <= score * 0.8;

  // Ecstasy e Triumph são sempre 'warning' (emoções extremas positivas)
  // EXCETO se há tristeza, frustração ou hostilidade moderada-alta
  if (ecstasy > tAdjusted.ecstasy || triumph > tAdjusted.triumph) {
    if (hasModerateSadness || hasModerateFrustration || hasLowHostility || hasModerateRelativeHostility || hasModerateRelativeSadness || hasModerateRelativeFrustration) {
      severity = 'info'; // Emoções negativas moderadas reduzem severidade mesmo de emoções intensas
    } else {
      severity = 'warning';
    }
  }
  // Outras emoções: baseado em contexto
  else {
    severity = 'warning'; // Padrão é warning
    if (hasModerateSadness || hasModerateFrustration || hasLowHostility || hasModerateRelativeHostility || hasModerateRelativeSadness || hasModerateRelativeFrustration) {
      severity = 'info'; // Emoções negativas moderadas reduzem severidade
    }
    if (typeof valence === 'number' && valence <= -0.1) {
      severity = 'info'; // Tom ligeiramente negativo
    }
    if (typeof arousal === 'number' && arousal < 0.2) {
      severity = 'info'; // Energia baixa
    }
    // FASE 2: Inclui todas as emoções de hostilidade e medo/ameaça para gradação
    if (
      anger > 0.03 ||
      disgust > 0.03 ||
      distress > 0.03 ||
      rage > 0.03 ||
      contempt > 0.03 ||
      fear > 0.03 ||
      horror > 0.03 ||
      terror > 0.03 ||
      anxiety > 0.03
    ) {
      severity = 'info'; // Pequenas emoções negativas (mas ainda bloqueia se > 0.05)
    }
  }

  // Define cooldown (mais longo para evitar spam)
  ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.primaryEmotion.positiveEngagement);

  // FASE 3: Gera feedback baseado na subcategoria dominante
  const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
  
  let message = `${name}: ótima energia e clareza! O grupo parece engajado.`;
  let tips: string[] = ['Mantenha esse tom', 'Aproveite para definir próximos passos'];

  // FASE 10.3.1: Contextualiza mensagem baseado em histórico e intensidade relativa
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 60_000, now);
    const relativeIntensity = hostilityScore > 0 ? hostilityScore / score : undefined;
    const contextualized = contextualizeMessage(message, tips, {
      recentEmotions,
      relativeIntensity,
      conflictingEmotions: hostilityScore > 0 ? [{ type: 'hostilidade', score: hostilityScore }] : undefined,
      currentEmotionType: 'entusiasmo_alto',
    });
    message = contextualized.message;
    tips = contextualized.tips;
  }

  // FASE 9: Mensagens específicas baseadas na emoção dominante (padronizado)
  // Padrão: emoção > threshold && emoção === score && emoção > outras na mesma categoria
  if (intenseScore > moderateScore && intenseScore > playfulScore && hasIntense) {
    // Engajamento Intenso é dominante
    const isEcstasyDominant = ecstasy > tAdjusted.ecstasy && ecstasy === intenseScore && ecstasy > Math.max(triumph, awe, admiration);
    const isTriumphDominant = triumph > tAdjusted.triumph && triumph === intenseScore && triumph > Math.max(ecstasy, awe, admiration);
    const isAweDominant = awe > tAdjusted.awe && awe === intenseScore && awe > Math.max(ecstasy, triumph, admiration);
    const isAdmirationDominant = admiration > tAdjusted.admiration && admiration === intenseScore && admiration > Math.max(ecstasy, triumph, awe);
    
    if (isEcstasyDominant) {
      message = `${name}: euforia extrema detectada! Momento de alta energia positiva.`;
      tips = ['Aproveite o momento de euforia', 'Canalize a energia para ações produtivas'];
    } else if (isTriumphDominant) {
      message = `${name}: sensação de vitória detectada! Momento de celebração.`;
      tips = ['Celebre a conquista', 'Reconheça o esforço do grupo'];
    } else if (isAweDominant) {
      message = `${name}: assombro ou admiração profunda detectada. Momento especial.`;
      tips = ['Reconheça o momento especial', 'Aproveite para reflexão profunda'];
    } else if (isAdmirationDominant) {
      message = `${name}: admiração detectada. Ambiente de respeito e apreciação.`;
      tips = ['Reconheça o que está sendo admirado', 'Mantenha o ambiente positivo'];
    }
  } else if (playfulScore > moderateScore && playfulScore > intenseScore && hasPlayful) {
    // Engajamento Lúdico é dominante
    const isAmusementDominant = amusement > tAdjusted.amusement && amusement === playfulScore && amusement > entrancement;
    const isEntrancementDominant = entrancement > tAdjusted.entrancement && entrancement === playfulScore && entrancement > amusement;
    
    if (isAmusementDominant) {
      message = `${name}: humor leve detectado. Ambiente descontraído e positivo.`;
      tips = ['Aproveite o momento de leveza', 'Mantenha o tom positivo'];
    } else if (isEntrancementDominant) {
      message = `${name}: absorção profunda detectada. Momento de atenção focada.`;
      tips = ['Aproveite o momento de foco', 'Evite interrupções desnecessárias'];
    }
  } else if (hasModerate) {
    // Engajamento Moderado é dominante (ou empate, ou única subcategoria detectada)
    const isEnthusiasmDominant = enthusiasm > t.enthusiasm && enthusiasm === moderateScore && enthusiasm > Math.max(joy, determination, excitement, interest);
    const isExcitementDominant = excitement > t.excitement && excitement === moderateScore && excitement > Math.max(joy, determination, enthusiasm, interest);
    const isJoyDominant = joy > t.joy && joy === moderateScore && joy > Math.max(determination, enthusiasm, excitement, interest);
    const isDeterminationDominant = determination > t.determination && determination === moderateScore && determination > Math.max(joy, enthusiasm, excitement, interest);
    
    if (isEnthusiasmDominant) {
      message = `${name}: entusiasmo detectado! Energia positiva e motivada.`;
      tips = ['Canalize o entusiasmo', 'Aproveite para avançar em objetivos'];
    } else if (isExcitementDominant) {
      message = `${name}: alta excitação detectada! Momento de energia elevada.`;
      tips = ['Aproveite a energia', 'Direcione para ações produtivas'];
    } else if (isJoyDominant) {
      message = `${name}: alegria detectada! Ambiente positivo e energizado.`;
      tips = ['Mantenha o tom positivo', 'Aproveite o momento'];
    } else if (isDeterminationDominant) {
      message = `${name}: determinação detectada! Momento de foco e propósito.`;
      tips = ['Aproveite a determinação', 'Canalize para objetivos claros'];
    }
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
