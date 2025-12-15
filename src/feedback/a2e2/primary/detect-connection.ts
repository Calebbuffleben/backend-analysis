import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';
import { ParticipantState, DetectionContext } from '../types';
import { calculateTensionLevel, getConnectionThreshold, hasRecentOverlap } from '../context/context-adjustments';
import { contextualizeMessage } from '../context/message-contextualizer';

/**
 * Detecta conexão social através de emoções primárias.
 * 
 * FASE 5: Melhorias na detecção de conexão com mensagens específicas e validações refinadas.
 * FASE 9: Padronizada lógica de detecção de emoção dominante.
 * FASE 10: Validações contextuais cruzadas refinadas e abrangentes.
 * FASE 10.1: Validações bidirecionais, combinações e níveis graduais de bloqueio.
 * FASE 10.2: Validações baseadas em intensidade relativa e expansão para tristeza/frustração.
 * FASE 10.3.1: Thresholds dinâmicos e bloqueio por oscilação rápida.
 * 
 * Regras A2E2:
 * - Detecta affection, emphatic pain, love OU sympathy acima do threshold (0.07)
 * - Usa o maior valor entre as quatro emoções
 * - Requer speech coverage >= 18%
 * - Cooldown de 75s (moderado, positivo mas não crítico)
 * 
 * Validações contextuais:
 * - Bloqueio por hostilidade/medo: todas as emoções de hostilidade e medo/ameaça > 0.05
 * - Valence mínimo: -0.2 (conexão requer tom neutro/positivo)
 * - Arousal entre 0.1 e 0.6 (conexão requer energia moderada)
 * - FASE 10: Bloqueio por tristeza muito alta: despair, grief, sorrow > 0.12
 * - FASE 10: Bloqueio por frustração muito alta: frustration > 0.12
 * - FASE 10.1: Bloqueio por hostilidade moderada: rage > 0.06, anger > 0.06
 * - FASE 10.1: Bloqueio por combinação hostilidade + frustração: (rage > 0.05 || anger > 0.05) && frustration > 0.08
 * 
 * Severidade:
 * - Sempre 'info' (conexão não é urgente, é positiva)
 * 
 * @param state Estado do participante com samples e EMA
 * @param ctx Contexto de detecção (meetingId, participantId, now, helpers)
 * @returns FeedbackEventPayload se conexão detectada, null caso contrário
 */
export function detectConnection(
  state: ParticipantState,
  ctx: DetectionContext,
): FeedbackEventPayload | null {
  const { meetingId, participantId, now } = ctx;
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechPrimary = A2E2_THRESHOLDS.gates.minSpeechPrimary;

  // FASE 10.3.1: Bloqueio por oscilação rápida
  // Se conexão foi detectada 3+ vezes nos últimos 30s, bloqueia para evitar spam
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    const recentConnectionCount = recentEmotions.filter((e) => e.type === 'conexao').length;
    if (recentConnectionCount >= 3) {
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

  // FASE 5: Validações contextuais refinadas
  // Conexão requer tom neutro/positivo e energia moderada
  // Obtém arousal e valence para validações e cálculo de tensão
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
  if (typeof valence === 'number' && valence < -0.2) {
    return null; // Conexão requer tom neutro/positivo
  }
  if (typeof arousal === 'number' && (arousal < 0.1 || arousal > 0.6)) {
    return null; // Conexão requer energia moderada
  }
  // FASE 5: Bloqueio básico por hostilidade e medo/ameaça (threshold baixo 0.05)
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
    return null; // Conexão com hostilidade ou medo significativo é contraditório
  }
  
  // FASE 10.1: Validações bidirecionais - hostilidade moderada bloqueia conexão
  // Nível 2 - Bloqueio forte: hostilidade moderada (> 0.06) bloqueia mesmo com threshold mais baixo
  // Isso garante que hostilidade moderada prevalece sobre conexão
  if (rage > 0.06 || anger > 0.06 || contempt > 0.06) {
    return null; // Hostilidade moderada prevalece sobre conexão
  }
  
  // FASE 5: Validação adicional - frustração muito alta pode bloquear conexão
  const frustration = state.ema.emotions.get('frustration') ?? 0;
  if (frustration > 0.12) {
    return null; // Frustração muito alta pode bloquear conexão emocional
  }

  // FASE 10.1: Validações baseadas em combinações - hostilidade + frustração
  // Combinação de hostilidade baixa + frustração moderada também bloqueia
  if ((rage > 0.05 || anger > 0.05 || contempt > 0.05) && frustration > 0.08) {
    return null; // Combinação hostilidade + frustração prevalece sobre conexão
  }

  // FASE 10: Validações contextuais cruzadas - tristeza muito alta bloqueia conexão
  const despair = state.ema.emotions.get('despair') ?? 0;
  const grief = state.ema.emotions.get('grief') ?? 0;
  const sorrow = state.ema.emotions.get('sorrow') ?? 0;
  const sadness = state.ema.emotions.get('sadness') ?? 0;
  const melancholy = state.ema.emotions.get('melancholy') ?? 0;
  if (despair > 0.12 || grief > 0.12 || sorrow > 0.12) {
    return null; // Tristeza muito profunda prevalece sobre conexão
  }

  // FASE 10.1: Validações baseadas em combinações - tristeza + frustração
  // Combinação de tristeza moderada + frustração moderada também bloqueia
  if ((sadness > 0.08 || despair > 0.08 || grief > 0.08 || sorrow > 0.08) && frustration > 0.08) {
    return null; // Combinação tristeza + frustração prevalece sobre conexão
  }

  // FASE 10.1: Validações baseadas em combinações - hostilidade + tristeza
  // Combinação de hostilidade baixa + tristeza moderada também bloqueia
  if ((rage > 0.05 || anger > 0.05 || contempt > 0.05) && (sadness > 0.08 || despair > 0.08 || grief > 0.08 || sorrow > 0.08)) {
    return null; // Combinação hostilidade + tristeza prevalece sobre conexão
  }

  // FASE 10.1: Validações graduais para medo/ameaça - medo moderado bloqueia conexão
  // Medo/ameaça moderada (> 0.06) bloqueia conexão (similar a hostilidade)
  if (terror > 0.06 || horror > 0.06 || fear > 0.06 || anxiety > 0.06) {
    return null; // Medo/ameaça moderada prevalece sobre conexão
  }

  // FASE 10.2: Expansão de validações - tristeza moderada bloqueia conexão
  // Tristeza moderada (> 0.10) bloqueia conexão (mais sensível que engajamento)
  if (sadness > 0.10 || melancholy > 0.10) {
    return null; // Tristeza moderada prevalece sobre conexão
  }

  // FASE 10.2: Expansão de validações - frustração moderada bloqueia conexão
  // Frustração moderada (> 0.10) bloqueia conexão
  if (frustration > 0.10) {
    return null; // Frustração moderada prevalece sobre conexão
  }

  // Obtém valores de emoções
  const affection = state.ema.emotions.get('affection') ?? 0;
  const emphaticPain = state.ema.emotions.get('emphatic pain') ?? 0;
  const love = state.ema.emotions.get('love') ?? 0;
  const sympathy = state.ema.emotions.get('sympathy') ?? 0;
  const score = Math.max(affection, emphaticPain, love, sympathy);

  // FASE 10.3.1: Bloqueio por sobreposição recente
  // Se conexão similar foi detectada nos últimos 20s e score atual não é > 20% maior, bloqueia
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 30_000, now);
    if (hasRecentOverlap(recentEmotions, 'conexao', score, 20_000, now)) {
      return null; // Sobreposição recente detectada, bloqueia para evitar spam
    }
  }

  // FASE 10.3.1: Calcula nível de tensão e ajusta thresholds dinamicamente
  // (arousal e valence já obtidos acima)
  const tensionLevel = ctx.getTensionLevel ? ctx.getTensionLevel(state) : calculateTensionLevel(arousal, valence);
  
  // Verifica threshold com ajuste dinâmico
  const t = A2E2_THRESHOLDS.primary.connection;
  const tAdjusted = {
    affection: getConnectionThreshold(t.affection, tensionLevel),
    emphaticPain: getConnectionThreshold(t.emphaticPain, tensionLevel),
    love: getConnectionThreshold(t.love, tensionLevel),
    sympathy: getConnectionThreshold(t.sympathy, tensionLevel),
  };
  
  if (score <= tAdjusted.affection) return null;

  // FASE 10.2: Validações baseadas em intensidade relativa
  // Calcula scores de emoções negativas para comparação
  const activeHostilityScore = Math.max(rage, anger, contempt, disgust, distress);
  const threatScore = Math.max(terror, horror, fear, anxiety);
  const hostilityScore = Math.max(activeHostilityScore, threatScore);
  const deepSadnessScore = Math.max(despair, grief, sorrow);
  const directSadnessScore = Math.max(sadness, melancholy);
  const sadnessScore = Math.max(deepSadnessScore, directSadnessScore);

  // FASE 10.2: Validações baseadas em subcategorias de conexão
  // Conexão profunda (love, emphatic pain) é mais resistente
  const deepConnectionScore = Math.max(love, emphaticPain);
  const lightConnectionScore = Math.max(affection, sympathy);
  const hasDeepConnection = love > tAdjusted.love || emphaticPain > tAdjusted.emphaticPain;
  const hasLightConnection = affection > tAdjusted.affection || sympathy > tAdjusted.sympathy;

  // Conexão profunda pode coexistir com hostilidade/tristeza baixa que bloquearia conexão leve
  if (hasDeepConnection) {
    // Bloqueia conexão profunda apenas se hostilidade/tristeza/frustração é 50% maior
    if (hostilityScore > deepConnectionScore * 1.5 || sadnessScore > deepConnectionScore * 1.5 || frustration > deepConnectionScore * 1.5) {
      return null; // Emoções negativas muito maiores bloqueiam conexão profunda
    }
  } else if (hasLightConnection) {
    // Conexão leve é mais sensível - bloqueia se hostilidade/tristeza/frustração é 30% maior
    if (hostilityScore > lightConnectionScore * 1.3 || sadnessScore > lightConnectionScore * 1.3 || frustration > lightConnectionScore * 1.3) {
      return null; // Emoções negativas moderadas bloqueiam conexão leve
    }
  }

  // Validações gerais baseadas em score total (fallback se não há subcategoria clara)
  // Frustração vs Conexão: bloqueia se frustração é 40% maior que conexão
  if (frustration > score * 1.4) {
    return null; // Frustração muito maior que conexão prevalece
  }

  // Hostilidade vs Conexão: bloqueia se hostilidade é 30% maior que conexão
  if (hostilityScore > score * 1.3) {
    return null; // Hostilidade muito maior que conexão prevalece
  }

  // Tristeza vs Conexão: bloqueia se tristeza é 20% maior que conexão
  if (sadnessScore > score * 1.2) {
    return null; // Tristeza muito maior que conexão prevalece
  }

  // Verifica cooldowns
  const type = 'conexao';
  if (ctx.inCooldown(state, type, now) || ctx.inGlobalCooldown(state, now)) {
    return null;
  }

  // FASE 5: Severidade sempre 'info' (conexão não é urgente, é positiva)
  const severity: 'info' | 'warning' = 'info';

  // Define cooldown
  ctx.setCooldown(state, type, now, A2E2_THRESHOLDS.cooldowns.primaryEmotion.connection);

  // FASE 5: Gera feedback baseado na emoção dominante
  const name = ctx.getParticipantName(meetingId, participantId) ?? participantId;
  
  let message = `${name}: conexão emocional detectada. Ambiente propício para diálogo profundo.`;
  let tips: string[] = ['Aproveite o momento de conexão', 'Considere explorar temas mais profundos'];

  // FASE 9: Mensagens específicas baseadas na emoção dominante (padronizado)
  // Padrão: emoção > threshold && emoção === score && emoção > outras na mesma categoria
  const isLoveDominant = love > tAdjusted.love && love === score && love > Math.max(affection, sympathy, emphaticPain);
  const isAffectionDominant = affection > tAdjusted.affection && affection === score && affection > Math.max(love, sympathy, emphaticPain);
  const isSympathyDominant = sympathy > tAdjusted.sympathy && sympathy === score && sympathy > Math.max(love, affection, emphaticPain);
  const isEmphaticPainDominant = emphaticPain > tAdjusted.emphaticPain && emphaticPain === score && emphaticPain > Math.max(love, affection, sympathy);
  
  if (isLoveDominant) {
    message = `${name}: vínculo profundo detectado. Momento de conexão emocional intensa.`;
    tips = ['Reconheça o vínculo', 'Aproveite para fortalecer relacionamentos', 'Crie espaço para expressão'];
  } else if (isAffectionDominant) {
    message = `${name}: carinho leve detectado. Ambiente de cuidado e atenção.`;
    tips = ['Aproveite o momento de carinho', 'Mantenha o ambiente acolhedor', 'Valide os sentimentos expressos'];
  } else if (isSympathyDominant) {
    message = `${name}: compaixão detectada. Ambiente de empatia e compreensão.`;
    tips = ['Reconheça a compaixão', 'Valide os sentimentos', 'Crie espaço para expressão'];
  } else if (isEmphaticPainDominant) {
    message = `${name}: sofrimento empático detectado. Momento de conexão através da dor compartilhada.`;
    tips = ['Valide o sofrimento', 'Crie espaço para expressão', 'Ofereça suporte se apropriado'];
  }

  // FASE 10.3.3: Contextualiza mensagem baseado em histórico e intensidade relativa
  if (ctx.getRecentEmotions) {
    const recentEmotions = ctx.getRecentEmotions(state, 60_000, now);
    // Usa os scores já calculados acima (hostilityScore, sadnessScore, frustration)
    // Calcula intensidade relativa de emoções negativas (se estão entre 60-80% da conexão)
    const maxNegativeScore = Math.max(frustration, hostilityScore, sadnessScore);
    const relativeIntensity = maxNegativeScore > 0 ? maxNegativeScore / score : undefined;
    const contextualized = contextualizeMessage(message, tips, {
      recentEmotions,
      relativeIntensity,
      conflictingEmotions: maxNegativeScore > 0 ? [{ type: maxNegativeScore === frustration ? 'frustracao_crescente' : maxNegativeScore === hostilityScore ? 'hostilidade' : 'tristeza', score: maxNegativeScore }] : undefined,
      currentEmotionType: 'conexao',
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

