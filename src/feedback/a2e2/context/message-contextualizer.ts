/**
 * FASE 10.3.1: Mensagens Contextuais Baseadas em Histórico
 * 
 * Este módulo ajusta mensagens baseado em:
 * - Histórico recente de emoções detectadas
 * - Intensidade relativa entre emoções conflitantes
 */

/**
 * Tipo de emoção detectada recentemente
 */
export interface RecentEmotion {
  type: string;
  ts: number;
}

/**
 * Contexto para contextualização de mensagens
 */
export interface MessageContext {
  recentEmotions?: RecentEmotion[];
  relativeIntensity?: number;
  conflictingEmotions?: Array<{ type: string; score: number }>;
  currentEmotionType?: string;
}

/**
 * Verifica se uma emoção específica foi detectada recentemente
 * 
 * @param recentEmotions Lista de emoções recentes
 * @param emotionType Tipo de emoção a verificar
 * @param windowMs Janela temporal em milissegundos (padrão: 60s)
 * @param now Timestamp atual
 * @returns true se a emoção foi detectada na janela temporal
 */
export function hasRecentEmotion(
  recentEmotions: RecentEmotion[] | undefined,
  emotionType: string,
  windowMs: number = 60_000,
  now: number = Date.now(),
): boolean {
  if (!recentEmotions || recentEmotions.length === 0) {
    return false;
  }

  const cutoff = now - windowMs;
  return recentEmotions.some(
    (emotion) => emotion.type === emotionType && emotion.ts >= cutoff,
  );
}

/**
 * Contextualiza mensagem de engajamento baseado em histórico
 * 
 * FASE 10.3.1: Se hostilidade foi detectada recentemente, ajusta mensagem
 */
export function contextualizeEngagementMessage(
  baseMessage: string,
  context: MessageContext,
): string {
  if (!context.recentEmotions || context.recentEmotions.length === 0) {
    return baseMessage;
  }

  const now = Date.now();
  const hasRecentHostility = hasRecentEmotion(
    context.recentEmotions,
    'hostilidade',
    60_000,
    now,
  );

  if (hasRecentHostility) {
    // Engajamento após hostilidade: reconhece a melhora
    return baseMessage.replace(
      'O grupo parece engajado.',
      'O grupo parece engajado após o momento anterior.',
    );
  }

  return baseMessage;
}

/**
 * Contextualiza mensagem de serenidade baseado em histórico
 * 
 * FASE 10.3.1: Se hostilidade ou frustração foram detectadas recentemente, ajusta mensagem
 */
export function contextualizeSerenityMessage(
  baseMessage: string,
  context: MessageContext,
): string {
  if (!context.recentEmotions || context.recentEmotions.length === 0) {
    return baseMessage;
  }

  const now = Date.now();
  const hasRecentHostility = hasRecentEmotion(
    context.recentEmotions,
    'hostilidade',
    60_000,
    now,
  );
  const hasRecentFrustration = hasRecentEmotion(
    context.recentEmotions,
    'frustracao_crescente',
    60_000,
    now,
  );

  if (hasRecentHostility || hasRecentFrustration) {
    // Serenidade após tensão: reconhece a transição
    if (baseMessage.includes('tranquilidade detectada')) {
      return baseMessage.replace(
        'tranquilidade detectada',
        'tranquilidade detectada. O ambiente parece estar se acalmando',
      );
    }
    if (baseMessage.includes('calma detectada')) {
      return baseMessage.replace(
        'calma detectada',
        'calma detectada. O ambiente parece estar se acalmando',
      );
    }
  }

  return baseMessage;
}

/**
 * Contextualiza mensagem de tristeza baseado em histórico
 * 
 * FASE 10.3.1: Se engajamento foi detectado recentemente, ajusta mensagem
 */
export function contextualizeSadnessMessage(
  baseMessage: string,
  context: MessageContext,
): string {
  if (!context.recentEmotions || context.recentEmotions.length === 0) {
    return baseMessage;
  }

  const now = Date.now();
  const hasRecentEngagement = hasRecentEmotion(
    context.recentEmotions,
    'entusiasmo_alto',
    60_000,
    now,
  );

  if (hasRecentEngagement) {
    // Tristeza após engajamento: reconhece a mudança
    if (baseMessage.includes('tristeza detectada')) {
      return baseMessage.replace(
        'tristeza detectada',
        'tristeza detectada. O grupo parece ter perdido o engajamento anterior',
      );
    }
    if (baseMessage.includes('desanimado')) {
      return baseMessage.replace(
        'desanimado',
        'desanimado após o engajamento anterior',
      );
    }
  }

  return baseMessage;
}

/**
 * Contextualiza mensagem baseado em intensidade relativa
 * 
 * FASE 10.3.1: Ajusta mensagem quando há emoções conflitantes com intensidade moderada
 */
export function contextualizeMessageByIntensity(
  baseMessage: string,
  context: MessageContext,
): { message: string; tips: string[] } {
  const tips: string[] = [];
  let message = baseMessage;

  if (context.relativeIntensity !== undefined && context.relativeIntensity >= 0.6 && context.relativeIntensity <= 0.8) {
    // Intensidade relativa moderada (60-80%): ajusta mensagem
    if (context.currentEmotionType === 'entusiasmo_alto') {
      message = message.replace(
        'ótima energia e clareza! O grupo parece engajado.',
        'ótima energia e clareza! O grupo parece engajado, mas há alguma tensão no ambiente.',
      );
      tips.push('Considere abordar a tensão sutilmente', 'Mantenha o tom positivo mas seja sensível');
    } else if (context.currentEmotionType === 'serenidade') {
      message = message.replace(
        'tranquilidade detectada',
        'tranquilidade detectada, mas há uma leve melancolia',
      );
      tips.push('Considere elevar sutilmente o humor', 'Mantenha a calma mas seja empático');
    } else if (context.currentEmotionType === 'conexao') {
      // FASE 10.3.3: Mensagens contextuais por intensidade relativa para conexão
      if (message.includes('conexão emocional detectada')) {
        message = message.replace(
          'conexão emocional detectada',
          'conexão emocional detectada, mas há alguma tensão no ambiente',
        );
        tips.push('Considere abordar a tensão com empatia', 'Mantenha o ambiente acolhedor mas seja sensível');
      } else if (message.includes('vínculo profundo detectado')) {
        message = message.replace(
          'vínculo profundo detectado',
          'vínculo profundo detectado, mas há alguma tensão no ambiente',
        );
        tips.push('Considere abordar a tensão com empatia', 'Mantenha o ambiente acolhedor mas seja sensível');
      } else if (message.includes('carinho leve detectado')) {
        message = message.replace(
          'carinho leve detectado',
          'carinho leve detectado, mas há alguma tensão no ambiente',
        );
        tips.push('Considere abordar a tensão com empatia', 'Mantenha o ambiente acolhedor mas seja sensível');
      } else if (message.includes('compaixão detectada')) {
        message = message.replace(
          'compaixão detectada',
          'compaixão detectada, mas há alguma tensão no ambiente',
        );
        tips.push('Considere abordar a tensão com empatia', 'Mantenha o ambiente acolhedor mas seja sensível');
      } else if (message.includes('sofrimento empático detectado')) {
        message = message.replace(
          'sofrimento empático detectado',
          'sofrimento empático detectado, mas há alguma tensão no ambiente',
        );
        tips.push('Considere abordar a tensão com empatia', 'Mantenha o ambiente acolhedor mas seja sensível');
      }
    }
  }

  return { message, tips };
}

/**
 * Contextualiza mensagem genérica baseado em contexto
 * 
 * Aplica todas as contextualizações relevantes
 */
export function contextualizeMessage(
  baseMessage: string,
  baseTips: string[],
  context: MessageContext,
): { message: string; tips: string[] } {
  let message = baseMessage;
  let tips = [...baseTips];

  // Aplica contextualizações específicas por tipo de emoção
  if (context.currentEmotionType === 'entusiasmo_alto') {
    message = contextualizeEngagementMessage(message, context);
  } else if (context.currentEmotionType === 'serenidade') {
    message = contextualizeSerenityMessage(message, context);
  } else if (context.currentEmotionType === 'tristeza') {
    message = contextualizeSadnessMessage(message, context);
  }

  // Aplica contextualização por intensidade relativa
  const intensityResult = contextualizeMessageByIntensity(message, context);
  message = intensityResult.message;
  if (intensityResult.tips.length > 0) {
    tips = [...tips, ...intensityResult.tips];
  }

  return { message, tips };
}

