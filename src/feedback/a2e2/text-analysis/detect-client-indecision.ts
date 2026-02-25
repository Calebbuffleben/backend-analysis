import { TextAnalysisResult } from "@/pipeline/text-analysis.service";
import { DetectionContext, ParticipantState, TextHistoryEntry } from "../types";
import { FeedbackEventPayload } from "@/feedback/feedback.types";
import { Logger } from "@nestjs/common";

export type ParticipantRoles = 'host' | 'guest';

type MeetingMaps = {
  trackToParticipant: Map<string, string>;
  participantToRoles: Map<string, Set<ParticipantRoles>>;
  participantToName: Map<string, string>;
};

export class DetectClientIndecision {
  private readonly logger = new Logger(DetectClientIndecision.name);
  private readonly byMeeting = new Map<string, MeetingMaps>();

  /**
   * API pública no padrão A2E2: (state, ctx) -> FeedbackEventPayload | null
   *
   * Mantém o core da lógica no método privado (paridade com o Aggregator),
   * apenas montando um `TextAnalysisResult` mínimo a partir de `state` + `ctx`.
   */
  run(state: ParticipantState, ctx: DetectionContext): FeedbackEventPayload | null {
    const meetingId = ctx.meetingId;
    const participantId = ctx.participantId;
    const now = ctx.now;

    // Verificação de role: Só bloqueia se tiver CERTEZA ABSOLUTA de que é host.
    // Se a função não existir ou retornar qualquer coisa diferente de 'host',
    // permite continuar (assume que pode ser cliente). Isso evita bloquear quando
    // o role ainda não foi identificado corretamente ou quando há incerteza.
    // 
    // IMPORTANTE: getParticipantRole retorna 'unknown' quando participante não encontrado.
    // Isso NÃO deve bloquear a detecção, pois pode ser um cliente ainda não identificado.
    const role = ctx.getParticipantRole?.(meetingId, participantId);
    
    // Só bloqueia se for EXATAMENTE 'host' E a função estiver disponível.
    // Qualquer outro valor ('guest', 'unknown', undefined, null) ou função ausente,
    // permite continuar a detecção.
    if (ctx.getParticipantRole && role === 'host') {
      return null;
    }
    
    // Para qualquer outro caso ('guest', 'unknown', undefined, null, ou função ausente),
    // continua a detecção assumindo que pode ser um cliente

    // Preencher nome do participante no mapa local (usado na montagem do payload).
    const participantName = ctx.getParticipantName(meetingId, participantId);
    if (participantName) {
      this.byMeeting.set(meetingId, {
        trackToParticipant: new Map<string, string>(),
        participantToRoles: new Map<string, Set<ParticipantRoles>>(),
        participantToName: new Map<string, string>([[participantId, participantName]]),
      });
    }

    const latestText = state.textAnalysis?.textHistory?.slice(-1)[0]?.text || '';

    // O detector só usa meetingId/participantId/text e lê o resto via state.textAnalysis.
    const evt = {
      meetingId,
      participantId,
      text: latestText,
      timestamp: now,
      analysis: {
        embedding: state.textAnalysis?.embedding ?? [],
        keywords: state.textAnalysis?.keywords ?? [],
        speech_act: state.textAnalysis?.speech_act ?? '',
      },
    } as unknown as TextAnalysisResult;

    const feedback = this.detectClientIndecision(state, evt, now);
    if (feedback && !feedback.participantName && participantName) {
      feedback.participantName = participantName;
    }
    return feedback;
  }

  private detectClientIndecision(
    state: ParticipantState,
    evt: TextAnalysisResult,
    now: number,
  ): FeedbackEventPayload | null {
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      return null;
    }
    
    // Permitir detecção mesmo com histórico vazio se houver sinal forte no chunk atual
    // Garantir que textHistory existe
    const textHistory = textAnalysis.textHistory ?? [];
    
    // Se histórico vazio, verificar se chunk atual tem sinal forte o suficiente
    if (textHistory.length === 0) {
      const currentIntensity = textAnalysis.sales_category_intensity ?? 0;
      const currentCategory = textAnalysis.sales_category;
      const hasStrongSignal = currentCategory &&
        ['stalling', 'objection_soft'].includes(currentCategory) &&
        currentIntensity >= 0.45;
      if (!hasStrongSignal) {
        return null;
      }
    }
    
    // ========================================================================
    // Verificar cooldown (2 minutos)
    // ========================================================================
    // Evita spam de feedbacks de indecisão
    const indecisionCooldownMsRaw = process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS;
    const indecisionCooldownMs = indecisionCooldownMsRaw
      ? Number.parseInt(indecisionCooldownMsRaw, 10)
      : 120000;
    const effectiveIndecisionCooldownMs = Number.isFinite(indecisionCooldownMs)
      ? Math.max(0, indecisionCooldownMs)
      : 120000;

    // Se cooldown configurado é 0, não bloquear por cooldown (mesmo que tenha sobrado estado antigo).
    if (effectiveIndecisionCooldownMs > 0 && this.inCooldown(state, 'sales_client_indecision', now)) {
      return null;
    }

    // Same-segment suppression: avoid repeating indecision for the same speech within 60s.
    // The aggregator sets lastFeedbackText/lastFeedbackTextAt when any text-based feedback is published.
    const SAME_SEGMENT_WINDOW_MS = 60_000;
    const timeSinceLastTextFeedback = typeof state.lastFeedbackTextAt === 'number'
      ? now - state.lastFeedbackTextAt
      : Infinity;
    if (
      timeSinceLastTextFeedback < SAME_SEGMENT_WINDOW_MS &&
      state.lastFeedbackText &&
      this.textSimilar(state.lastFeedbackText, evt.text ?? '', 0.6)
    ) {
      return null;
    }

    // ========================================================================
    // Detectar indecisão ativa (janela curta de chunks)
    // ========================================================================
    // Nota: detectActiveIndecision() já valida se há chunks suficientes
    // e se há ≥ 1 sinal válido, então não precisamos verificar antes
    const activeIndecision = this.detectActiveIndecision(state, 5);

    if (!activeIndecision || !activeIndecision.isActive) {
      // Fallback para conversas longas: verificar sinais fortes recentes na janela temporal
      const recentSignals = this.getRecentIndecisionSignals(state, now, 60000, 0.35);
      const recentSignalsCount = recentSignals.length;
      const recentAverageIntensity = recentSignalsCount > 0
        ? recentSignals.reduce((sum, entry) => sum + (entry.sales_category_intensity ?? 0), 0) / recentSignalsCount
        : 0;
      const hasRecentStrongPattern = recentSignalsCount >= 3 && recentAverageIntensity >= 0.35;

      if (hasRecentStrongPattern) {
        const confidence = recentAverageIntensity;
        let representativePhrases = this.extractRepresentativePhrases(
          state,
          5,
          5,
          0.15,
        );

        if (representativePhrases.length === 0) {
          const current = (evt.text || '').trim();
          if (current) {
            const maxLen = 180;
            const snippet = current.length > maxLen ? `${current.slice(0, maxLen - 3)}...` : current;
            representativePhrases = [snippet];
          }
        }

        const window = this.window(state, now, 60000);
        if (effectiveIndecisionCooldownMs > 0) {
          this.setCooldown(
            state,
            'sales_client_indecision',
            now,
            effectiveIndecisionCooldownMs,
          );
        }

        return {
          id: this.makeId(),
          type: 'sales_client_indecision',
          severity: 'warning',
          ts: now,
          meetingId: evt.meetingId,
          participantId: evt.participantId,
          participantName: this.getParticipantName(evt.meetingId, evt.participantId) ?? undefined,
          window: { start: window.start, end: window.end },
          message: '⏳ Cliente demonstrando indecisão',
          tips: ['Pergunte o que está travando', 'Proponha próximo passo concreto'],
          metadata: {
            confidence: Math.round(confidence * 100) / 100,
            recent_signals_count: recentSignalsCount,
            recent_average_intensity: Math.round(recentAverageIntensity * 100) / 100,
            representative_phrases: representativePhrases,
            sales_category: textAnalysis?.sales_category ?? undefined,
            sales_category_confidence: textAnalysis?.sales_category_confidence ?? undefined,
            indecision_metrics: textAnalysis?.indecision_metrics ?? undefined,
            conditional_keywords_detected: textAnalysis?.conditional_keywords_detected ?? undefined,
          },
        };
      }

      const inferredIndecisionCategory = this.inferIndecisionCategoryFromScores(textAnalysis);
      const indecisionMetrics = textAnalysis?.indecision_metrics;
      const conditionalKeywords = textAnalysis?.conditional_keywords_detected ?? [];
      const hasStrongMetrics =
        (indecisionMetrics?.postponement_likelihood ?? 0) >= 0.6 ||
        (indecisionMetrics?.conditional_language_score ?? 0) >= 0.5 ||
        (indecisionMetrics?.indecision_score ?? 0) >= 0.6;
      const hasConditionalKeywords = conditionalKeywords.length >= 2;
      const bestScore = textAnalysis?.sales_category_best_score ?? 0;
      const intensity = textAnalysis?.sales_category_intensity ?? 0;
      const hasStrongIndecisionSignal =
        inferredIndecisionCategory !== null &&
        (bestScore >= 0.22 || intensity >= 0.35) &&
        (hasStrongMetrics || hasConditionalKeywords);

      if (hasStrongIndecisionSignal) {
        const confidence = Math.max(bestScore, intensity);
        let representativePhrases = this.extractRepresentativePhrases(
          state,
          5,
          5,
          0.15,
        );

        if (representativePhrases.length === 0) {
          const current = (evt.text || '').trim();
          if (current) {
            const maxLen = 180;
            const snippet = current.length > maxLen ? `${current.slice(0, maxLen - 3)}...` : current;
            representativePhrases = [snippet];
          }
        }

        const window = this.window(state, now, 60000);
        if (effectiveIndecisionCooldownMs > 0) {
          this.setCooldown(
            state,
            'sales_client_indecision',
            now,
            effectiveIndecisionCooldownMs,
          );
        }

        return {
          id: this.makeId(),
          type: 'sales_client_indecision',
          severity: 'warning',
          ts: now,
          meetingId: evt.meetingId,
          participantId: evt.participantId,
          participantName: this.getParticipantName(evt.meetingId, evt.participantId) ?? undefined,
          window: { start: window.start, end: window.end },
          message: '⏳ Cliente demonstrando indecisão',
          tips: ['Pergunte o que está travando', 'Proponha próximo passo concreto'],
          metadata: {
            confidence: Math.round(confidence * 100) / 100,
            representative_phrases: representativePhrases,
            sales_category: inferredIndecisionCategory ?? undefined,
            sales_category_confidence: textAnalysis?.sales_category_confidence ?? undefined,
            indecision_metrics: textAnalysis?.indecision_metrics ?? undefined,
            conditional_keywords_detected: textAnalysis?.conditional_keywords_detected ?? undefined,
          },
        };
      }
      return null;
    }

    // Confidence passa a ser a média de INTENSITY (não confidence) dos sinais válidos
    // Nota: detectActiveIndecision() já garante que se isActive: true,
    // então averageIntensity >= dynamicMinAverageIntensity (dinâmico), então não precisamos verificar novamente
    const confidence = activeIndecision.averageIntensity; // PRIORIDADE 1: Usar intensity como confidence final

    // ========================================================================
    // Extrair frases representativas
    // ========================================================================
    // Obtém frases que exemplificam o padrão de indecisão
    // Extrair frases representativas (threshold baixo: este passo é explicativo,
    // não deve bloquear o envio do feedback quando os padrões já foram detectados).
    let representativePhrases = this.extractRepresentativePhrases(
      state,
      5,     // Últimos 5 chunks
      5,     // Máximo 5 frases
      0.15   // Confiança mínima
    );

    // Fallback: se não houver frases no histórico (ex.: confidence muito baixo),
    // use um trecho do texto atual para não bloquear a entrega do feedback.
    if (representativePhrases.length === 0) {
      const current = (evt.text || '').trim();
      if (current) {
        const maxLen = 180;
        const snippet = current.length > maxLen ? `${current.slice(0, maxLen - 3)}...` : current;
        representativePhrases = [snippet];
      }
    }
    // ========================================================================
    // Construir mensagem curta e direta
    // ========================================================================
    // Mensagem simplificada baseada na indecisão ativa detectada
    const message = '⏳ Cliente demonstrando indecisão';

    // ========================================================================
    // Construir tips curtas e práticas (máximo 2)
    // ========================================================================
    const tips: string[] = [];

    // Tip baseado no número de sinais detectados
    if (activeIndecision.signalsCount >= 3) {
      tips.push('Crie urgência ou ofereça incentivo');
    } else {
      tips.push('Pergunte o que está travando');
    }

    // Adicionar uma dica de ação
    tips.push('Proponha próximo passo concreto');

    // ========================================================================
    // Gerar feedback
    // ========================================================================
    const window = this.window(state, now, 60000); // Últimos 60s
    if (effectiveIndecisionCooldownMs > 0) {
      this.setCooldown(
        state,
        'sales_client_indecision',
        now,
        effectiveIndecisionCooldownMs,
      );
    }

    return {
      id: this.makeId(),
      type: 'sales_client_indecision',
      severity: 'warning',
      ts: now,
      meetingId: evt.meetingId,
      participantId: evt.participantId,
      participantName: this.getParticipantName(evt.meetingId, evt.participantId) ?? undefined,
      window: { start: window.start, end: window.end },
      message,
      tips,
      metadata: {
        confidence: Math.round(confidence * 100) / 100, // Arredondar para 2 casas decimais
        valid_signals_count: activeIndecision.signalsCount,
        valid_signals_average_confidence: Math.round(activeIndecision.averageConfidence * 100) / 100,
        representative_phrases: representativePhrases,
        sales_category: textAnalysis.sales_category ?? undefined,
        sales_category_confidence: textAnalysis.sales_category_confidence ?? undefined,
        indecision_metrics: textAnalysis.indecision_metrics ?? undefined,
        conditional_keywords_detected: textAnalysis.conditional_keywords_detected ?? undefined,
      },
    };
  }

  /**
   * Verifica se chunk é não semântico (mensagens de sistema, ruído claro).
   * 
   * NOTA: Este filtro é aplicado APENAS quando NÃO há classificação ML disponível.
   * Se o SBERT classificou o texto, a classificação ML tem prioridade (semântica > sintaxe).
   * 
   * Padrões detectados:
   * - "X segundos restantes" / "X minutos restantes" (mensagens de sistema explícitas)
   * - Textos muito curtos sem palavras significativas (ruído de transcrição)
   * @param text Texto do chunk
   * @returns true se chunk for não semântico
   */
  private isNonSemanticChunk(text: string): boolean {
    const textLower = text.toLowerCase().trim();
    
    // Padrão: "X segundos/minutos restantes" (mensagens de sistema explícitas)
    const timeRemainingPattern = /\d+\s*(segundos?|minutos?)\s*restantes?/i;
    if (timeRemainingPattern.test(textLower)) {
      return true;
    }
    
    // Textos muito curtos (< 10 caracteres) sem palavras significativas (ruído de transcrição)
    if (textLower.length < 10) {
      const words = textLower.split(/\s+/).filter(w => w.length > 0);
      // Lista de palavras muito comuns que não agregam significado
      const noiseWords = ['ok', 'ah', 'hmm', 'uh', 'é', 'sim', 'não', 'tá', 'entendi'];
      if (words.length <= 1 && noiseWords.some(noise => textLower.includes(noise))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detecta indecisão ativa baseada em janela curta de chunks (3-5).
   * 
   * Regras:
   * - Avalia apenas últimos 3-5 chunks (não janela temporal)
   * - Ignora chunks não semânticos (tempo restante, mensagens de sistema)
   * - Chunk válido se: categoria ∈ {stalling, objection_soft} E confiança ≥ 0.15
   * - Indecisão ativa se: ≥ 1 sinal válido E confiança média ≥ 0.25
   * 
   * @param state Estado do participante
   * @param maxChunks Número máximo de chunks a avaliar (padrão: 5)
   * @returns Objeto com informações sobre indecisão ativa ou null
   */
  private detectActiveIndecision(
    state: ParticipantState,
    maxChunks: number = 5
  ): {
    isActive: boolean;
    validSignals: Array<{ text: string; category: string; intensity: number; confidence: number }>;
    averageIntensity: number;
    averageConfidence: number;
    signalsCount: number;
  } | null {
    
    // Se não houver textAnalysis, não há nada para analisar
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      return null;
    }

    const textHistory = textAnalysis.textHistory ?? [];
    // Se não houver histórico, não há nada para analisar
    if (textHistory.length === 0) {
      return null;
    }

    const indecisionCategories = ['stalling', 'objection_soft'];
    const baseMinConfidence = 0.20; // Coleta: só chunks com intensity >= 20%
    const minSignals = 1;

    // ========================================================================
    // Obter últimos N chunks (mais recentes primeiro)
    // ========================================================================
    const recentChunks = textHistory.slice(-maxChunks);

    // ========================================================================
    // Filtrar chunks não semânticos e extrair sinais válidos
    // ========================================================================
    // PRIORIDADE 1: Armazenar intensity (não confidence) para validação final
    const validSignals: Array<{ text: string; category: string; intensity: number; confidence: number }> = [];

    let chunkIndex = 0;
    for (const entry of recentChunks) {
      chunkIndex++;
      // IMPORTANT: intensity is used for signal collection (semantic strength)
      // confidence is used only for final validation (class separation)
      // Do NOT use confidence for initial filtering
      //
      // Se o modelo ML classificou como indecisão com força semântica suficiente,
      // isso é a fonte mais confiável (ignora filtros heurísticos de texto)
      const category = entry.sales_category;
      const intensity = entry.sales_category_intensity; // Use intensity for collection
      const confidence = entry.sales_category_confidence; // Use confidence for validation only

      // Verificar se tem classificação ML válida
      // IMPORTANT: Use intensity for collection (semantic strength), confidence for validation only
      // FASE 3: Usar threshold base para coleta inicial (thresholds dinâmicos aplicados depois)
      const hasCategory = category && category !== null;
      const hasIndecisionCategory = hasCategory && indecisionCategories.includes(category);
      const hasValidIntensity = intensity !== null && intensity !== undefined;
      const hasMinIntensity = hasValidIntensity && intensity >= baseMinConfidence; // Use intensity for collection
      
      const hasValidMLClassification = hasCategory && hasIndecisionCategory && hasValidIntensity && hasMinIntensity;
      
      // Chunk válido baseado em classificação ML!
      // Isso significa que o chunk tem uma classificação de indecisão válida
      if (hasValidMLClassification) {
        // intensity representa força semântica real, confidence pode ser muito baixo
        const intensityForValidation = intensity ?? 0;
        const confidenceForLogging = confidence ?? 0;
        
        validSignals.push({
          text: entry.text,
          category,
          intensity: intensityForValidation, // PRIORIDADE 1: Usar intensity para validação
          confidence: confidenceForLogging, // Manter confidence apenas para logs
        });
        continue;
      }

      // Filtros heurísticos servem como fallback para casos onde não há
      // classificação ML disponível (mensagens de sistema, ruído de transcrição)
      const isNonSemantic = this.isNonSemanticChunk(entry.text);
      if (isNonSemantic) {
        continue;
      }   
      // Se chegou aqui, não tem classificação ML válida E passou filtros heurísticos
      // (Não adiciona aos validSignals porque precisa de classificação ML para detectar indecisão)
    }

    // ========================================================================
    // Verificar se há indecisão ativa
    // ========================================================================
    const signalsCount = validSignals.length;
    
    let dynamicMinAverageIntensity: number;
    if (signalsCount === 1) {
      dynamicMinAverageIntensity = 0.30;
    } else if (signalsCount >= 2 && signalsCount < 3) {
      dynamicMinAverageIntensity = 0.22;
    } else {
      dynamicMinAverageIntensity = 0.18;
    }
    
    if (signalsCount < minSignals) {
      return {
        isActive: false,
        validSignals,
        averageIntensity: 0,
        averageConfidence: 0,
        signalsCount,
      };
    }

    // Todos os sinais coletados com baseMinConfidence são mantidos para cálculo da média
    // O threshold dinâmico é aplicado APENAS na validação final (average confidence)
    // Isso evita descartar sinais já coletados (ex: 1 sinal com 0.17 coletado com 0.15, mas descartado com 0.20)
    const filteredSignals = validSignals; // Todos os sinais coletados são mantidos
    const filteredSignalsCount = signalsCount; // Quantidade permanece a mesma

    // PRIORIDADE 1: Calcular média de INTENSITY (não confidence) para validação final
    const averageIntensity = filteredSignals.reduce((sum, s) => sum + s.intensity, 0) / filteredSignalsCount;
    
    // Calcular média de confidence apenas para logs e retrocompatibilidade
    const averageConfidence = filteredSignals.reduce((sum, s) => sum + s.confidence, 0) / filteredSignalsCount;

    // Este é o único lugar onde o threshold dinâmico é aplicado, evitando filtragem dupla
    if (averageIntensity < dynamicMinAverageIntensity) {
      return {
        isActive: false,
        validSignals: filteredSignals,
        averageIntensity,
        averageConfidence,
        signalsCount: filteredSignalsCount,
      };
    }

    return {
      isActive: true,
      validSignals: filteredSignals,
      averageIntensity,
      averageConfidence,
      signalsCount: filteredSignalsCount,
    };
  }

  private getRecentIndecisionSignals(
    state: ParticipantState,
    now: number,
    windowMs: number = 60000,
    minIntensity: number = 0.25,
  ): TextHistoryEntry[] {
    const textHistory = state.textAnalysis?.textHistory ?? [];
    if (textHistory.length === 0) {
      return [];
    }

    const cutoffTime = now - windowMs;
    const indecisionCategories = ['stalling', 'objection_soft'];

    return textHistory.filter(entry => {
      if (entry.timestamp < cutoffTime) {
        return false;
      }
      if (!entry.sales_category || !indecisionCategories.includes(entry.sales_category)) {
        return false;
      }
      return (entry.sales_category_intensity ?? 0) >= minIntensity;
    });
  }

  private inferIndecisionCategoryFromScores(
    textAnalysis?: ParticipantState['textAnalysis'],
  ): string | null {
    if (!textAnalysis) {
      return null;
    }

    const indecisionCategories = new Set(['stalling', 'objection_soft']);
    const top3 = textAnalysis.sales_category_top_3 ?? [];
    const bestScore = textAnalysis.sales_category_best_score ?? 0;

    if (top3.length === 0) {
      return null;
    }

    const best = top3[0];
    if (best && indecisionCategories.has(best.category)) {
      return best.category;
    }

    const bestIndecision = top3.find((entry) => indecisionCategories.has(entry.category));
    if (!bestIndecision) {
      return null;
    }

    const scoreGap = bestScore - bestIndecision.score;
    if (bestIndecision.score >= 0.22 && scoreGap <= 0.05) {
      return bestIndecision.category;
    }

    return null;
  }
 
  private textSimilar(a: string, b: string, threshold = 0.6): boolean {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
    if (wordsA.size === 0 || wordsB.size === 0) return a === b;
    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    const containment = Math.max(intersection / wordsA.size, intersection / wordsB.size);
    return containment >= threshold;
  }

  private inCooldown(state: ParticipantState, type: string, now: number): boolean {
    const until = state.cooldownUntilByType.get(type);
    return typeof until === 'number' && until > now;
  }

  private setCooldown(state: ParticipantState, type: string, now: number, ms: number): void {
    state.cooldownUntilByType.set(type, now + ms);
    state.lastFeedbackAt = now;
  }

  private makeId(): string {
    const rnd = Math.floor(Math.random() * 1e9).toString(36);
    return `${Date.now().toString(36)}-${rnd}`;
  }

  private window(
    state: ParticipantState,
    now: number,
    ms: number,
  ): {
    start: number;
    end: number;
    samplesCount: number;
    speechCount: number;
    meanRmsDbfs?: number;
  } {
    const start = now - ms;
    let samplesCount = 0;
    let speechCount = 0;
    let rmsSum = 0;
    let rmsN = 0;
    for (let i = state.samples.length - 1; i >= 0; i--) {
      const s = state.samples[i];
      if (s.ts < start) break;
      samplesCount++;
      if (s.speech) speechCount++;
      if (typeof s.rmsDbfs === 'number') {
        rmsSum += s.rmsDbfs;
        rmsN++;
      }
    }
    const meanRmsDbfs = rmsN > 0 ? rmsSum / rmsN : undefined;
    return { start, end: now, samplesCount, speechCount, meanRmsDbfs };
  }

  private extractRepresentativePhrases(
    state: ParticipantState,
    maxChunks: number = 5, // Últimos N chunks
    maxPhrases: number = 5,
    minConfidence: number = 0.15 // Threshold mais permissivo
  ): string[] {
    const textHistory = state.textAnalysis?.textHistory ?? [];
    if (textHistory.length === 0) {
      return [];
    }

    const indecisionCategories = ['stalling', 'objection_soft'];

    // Obter últimos N chunks (mais recentes primeiro)
    const recentChunks = textHistory.slice(-maxChunks);

    // Filtrar textos de indecisão
    const indecisionTexts = recentChunks
      .filter(entry => {
        const category = entry.sales_category;
        const confidence = entry.sales_category_confidence;
        
        const hasValidMLClassification = 
          category && 
          category !== null && 
          indecisionCategories.includes(category) &&
          confidence !== null && 
          confidence !== undefined && 
          confidence >= minConfidence;
        
        if (hasValidMLClassification) {
          // Classificação ML válida - aceita mesmo se tiver padrões de texto
          return true;
        }
        
        // Se não tem classificação ML, não pode extrair frase representativa
        // (filtro heurístico apenas para evitar processamento desnecessário)
        if (this.isNonSemanticChunk(entry.text)) {
          return false;
        }
        
        // Se chegou aqui, não tem classificação ML válida E passou filtros heurísticos
        // Mas sem classificação ML, não temos frase representativa de indecisão
        return false;
      })
      // Ordenar por confiança (maior primeiro)
      .sort((a, b) => (b.sales_category_confidence ?? 0) - (a.sales_category_confidence ?? 0))
      // Limitar quantidade
      .slice(0, maxPhrases)
      // Extrair apenas o texto
      .map(entry => entry.text);

    return indecisionTexts;
  }

  getParticipantName(meetingId: string, participantIdentity: string): string | undefined {
    return this.byMeeting.get(meetingId)?.participantToName.get(participantIdentity);
  }
}