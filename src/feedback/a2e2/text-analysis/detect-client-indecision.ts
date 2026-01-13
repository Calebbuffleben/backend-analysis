import { TextAnalysisResult } from "@/pipeline/text-analysis.service";
import { DetectionContext, ParticipantState } from "../types";
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

    this.logger.log(`🔴 [INDECISION] Detector called for ${meetingId}/${participantId}`);

    // Só faz sentido detectar "indecisão do cliente" para o lado cliente (guest).
    // Se o backend conseguir identificar o host, evitamos falso positivo no vendedor.
    const role = ctx.getParticipantRole?.(meetingId, participantId);
    if (role === 'host') {
      this.logger.debug('❌ [INDECISION] Skipping host participant');
      return null;
    }

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

    this.logger.log(`[INDECISION] Latest text: "${latestText.substring(0, 100)}..."`);
    this.logger.log(`[INDECISION] Text history length: ${state.textAnalysis?.textHistory?.length || 0}`);

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
    this.logger.debug('🔍 [INDECISION] Checking client indecision...', {
      meetingId: evt.meetingId,
      participantId: evt.participantId,
    });

    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      this.logger.debug('❌ [INDECISION] No text analysis data');
      return null;
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
      const remainingMs = this.cooldownRemainingMs(state, 'sales_client_indecision', now);
      this.logger.debug('❌ [INDECISION] In cooldown', {
        remainingMs,
        remainingSec: Math.round(remainingMs / 1000),
      });
      return null;
    }

    // ========================================================================
    // Verificar volume mínimo de dados
    // ========================================================================
    // Requer pelo menos 1 chunk com categoria para análise responsiva (mais permissivo)
    const aggregated = textAnalysis.sales_category_aggregated;
    const chunksCount = aggregated?.chunks_with_category ?? 0;
    const minChunksRaw = process.env.SALES_CLIENT_INDECISION_MIN_CHUNKS;
    const minChunksParsed = minChunksRaw ? Number.parseInt(minChunksRaw.replace(/"/g, ''), 10) : 1;
    const minChunks = Number.isFinite(minChunksParsed) ? Math.max(1, minChunksParsed) : 1;
    const hasEnoughData = chunksCount >= minChunks;

    this.logger.debug('📊 [INDECISION] Data volume check', {
      chunksCount,
      hasEnoughData,
      threshold: minChunks,
    });

    if (!hasEnoughData) {
      this.logger.debug('❌ [INDECISION] Not enough data - waiting for more chunks');
      return null;
    }

    this.logger.log(`[INDECISION] ✅ Has enough data (${chunksCount}/${minChunks}) - proceeding with analysis`);

    // ========================================================================
    // Detectar indecisão ativa (episódica)
    // ========================================================================
    this.logger.log('[INDECISION] 🎯 Calling episodic indecision detection...');
    const patterns = this.detectIndecisionPatterns(state);

    this.logger.debug('🎯 [INDECISION] Episodic analysis result', {
      indecisionActive: patterns.indecisionActive,
      confidenceScore: patterns.confidenceScore.toFixed(3),
      rationale: patterns.rationale,
    });

    // Se indecisão não está ativa, não gerar feedback
    if (!patterns.indecisionActive) {
      this.logger.log(`❌ [INDECISION] Indecision not active: ${patterns.rationale}`);
      return null;
    }

    // ========================================================================
    // Usar confidence score da análise episódica
    // ========================================================================
    // Indecisão ativa já foi confirmada, usar o confidence score calculado
    const confidence = patterns.confidenceScore;

    this.logger.debug('📊 [INDECISION] Using episodic confidence score', {
      confidence: confidence.toFixed(3),
      rationale: patterns.rationale,
    });

    // Confiança já foi validada na análise episódica (≥ 0.25 avg confidence + ≥2 sinais)

    // ========================================================================
    // Extrair frases representativas
    // ========================================================================
    // Obtém frases que exemplificam o padrão de indecisão
    // Extrair frases representativas (threshold baixo: este passo é explicativo,
    // não deve bloquear o envio do feedback quando os padrões já foram detectados).
    let representativePhrases = this.extractRepresentativePhrases(
      state,
      now,
      60000, // Últimos 60s
      5,     // Máximo 5 frases
      0.1    // Confiança mínima
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

    this.logger.debug('💬 [INDECISION] Representative phrases', {
      count: representativePhrases.length,
      phrases: representativePhrases.slice(0, 3), // Mostrar apenas as 3 primeiras
    });

    // Não bloquear envio por falta de frases (isso é explicativo/metadata).
    // Se não houver frases, seguimos com metadata vazia.

    this.logger.log('✅ [INDECISION] Episodic indecision active! Generating immediate feedback...', {
      confidence: confidence.toFixed(3),
      rationale: patterns.rationale,
      phrasesCount: representativePhrases.length,
    });

    this.logger.log('📣 [INDECISION] Will generate humanized feedback', {
      meetingId: evt.meetingId,
      participantId: evt.participantId,
    });

    // ========================================================================
    // Mensagem baseada na análise episódica
    // ========================================================================
    const message = 'Cliente adiando a decisão, proponha um próximo passo concreto';

    // ========================================================================
    // Tip acionável e imediato
    // ========================================================================
    const tips = ['Proponha próximo passo concreto'];

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
        indecision_active: patterns.indecisionActive,
        rationale: patterns.rationale,
        representative_phrases: representativePhrases,
        sales_category: textAnalysis.sales_category ?? undefined,
        sales_category_confidence: textAnalysis.sales_category_confidence ?? undefined,
        sales_category_aggregated: aggregated ?? undefined,
        indecision_metrics: textAnalysis.indecision_metrics ?? undefined,
        conditional_keywords_detected: textAnalysis.conditional_keywords_detected ?? undefined,
      } as any,
    };
  }

/**
 * Detecta indecisão ativa baseada em análise episódica.
 *
 * Seguindo regras específicas:
 * - Indecisão é episódica (janelas curtas 3-5 chunks)
 * - Nunca usa proporção global da conversa
 * - Ignora chunks não semânticos (tempo restante, ruído)
 * - Sinal válido: categoria ∈ {stalling, objection_soft, decision_postponement} + confiança ≥ 0.15
 * - Indecisão ativa: ≥ 2 sinais válidos + confiança média ≥ 0.25
 *
 * @param state Estado do participante contendo análise de texto
 * @returns Objeto com status da indecisão ativa, confidence score e rationale
 *
 * @example
 * ```typescript
 * const result = this.detectIndecisionPatterns(state);
 * if (result.indecisionActive) {
 *   // Indecisão episódica detectada com alta confiança
 *   console.log(result.rationale); // Explicação objetiva
 * }
 * ```
 */
  private detectIndecisionPatterns(
    state: ParticipantState
  ): {
    indecisionActive: boolean;
    confidenceScore: number;
    rationale: string;
  } {
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      return {
        indecisionActive: false,
        confidenceScore: 0,
        rationale: 'No text analysis available',
      };
    }

    const textHistory = textAnalysis.textHistory ?? [];
    if (textHistory.length === 0) {
      return {
        indecisionActive: false,
        confidenceScore: 0,
        rationale: 'No text history available',
      };
    }

    // ========================================================================
    // Janela curta: últimos 3-5 chunks (episódica)
    // ========================================================================
    const windowSize = Math.min(5, Math.max(3, Math.floor(textHistory.length * 0.6)));
    const recentChunks = textHistory.slice(-windowSize);

    // ========================================================================
    // Filtrar chunks não semânticos
    // ========================================================================
    const semanticChunks = recentChunks.filter(chunk => {
      const text = (chunk.text ?? '').toLowerCase().trim();

      // Ignorar mensagens de sistema/ruído
      if (text.includes('segundos restantes') ||
          text.includes('minutos restantes') ||
          text.includes('participando da chamada') ||
          text.length < 3 ||
          /^\d+$/.test(text.replace(/\s/g, ''))) {
        return false;
      }

      return true;
    });

    if (semanticChunks.length === 0) {
      return {
        indecisionActive: false,
        confidenceScore: 0,
        rationale: 'No semantic chunks in recent window',
      };
    }

    // ========================================================================
    // Identificar sinais válidos de indecisão
    // ========================================================================
    const validIndecisionSignals = semanticChunks.filter(chunk => {
      const category = chunk.sales_category;
      const confidence = chunk.sales_category_confidence ?? 0;

      // Critérios: categoria semântica + confiança ≥ 0.15
      const validCategories = ['stalling', 'objection_soft', 'decision_postponement'];
      const hasValidCategory = category && validCategories.includes(category);
      const hasMinConfidence = confidence >= 0.15;

      return hasValidCategory && hasMinConfidence;
    });

    // ========================================================================
    // Calcular métricas de indecisão ativa
    // ========================================================================
    const signalCount = validIndecisionSignals.length;
    const hasEnoughSignals = signalCount >= 2;

    let avgConfidence = 0;
    if (validIndecisionSignals.length > 0) {
      avgConfidence = validIndecisionSignals.reduce((sum, chunk) =>
        sum + (chunk.sales_category_confidence ?? 0), 0
      ) / validIndecisionSignals.length;
    }
    const hasMinAvgConfidence = avgConfidence >= 0.25;

    // ========================================================================
    // Decisão final
    // ========================================================================
    const indecisionActive = hasEnoughSignals && hasMinAvgConfidence;
    const confidenceScore = indecisionActive ? Math.min(1, avgConfidence) : 0;

    // ========================================================================
    // Rationale objetivo
    // ========================================================================
    let rationale = '';
    if (!indecisionActive) {
      if (!hasEnoughSignals) {
        rationale = `${signalCount}/${semanticChunks.length} valid signals (need ≥2)`;
      } else if (!hasMinAvgConfidence) {
        rationale = `Avg confidence ${avgConfidence.toFixed(2)} < 0.25`;
      }
    } else {
      const categories = [...new Set(validIndecisionSignals.map(s => s.sales_category))];
      rationale = `${signalCount} signals, ${avgConfidence.toFixed(2)} avg conf, categories: ${categories.join(', ')}`;
    }

    // ========================================================================
    // Logs detalhados
    // ========================================================================
    this.logger.debug('🎯 [INDECISION] Episodic analysis', {
      windowSize,
      semanticChunksCount: semanticChunks.length,
      validSignalsCount: signalCount,
      avgConfidence: avgConfidence.toFixed(3),
      indecisionActive,
      confidenceScore: confidenceScore.toFixed(3),
      rationale,
    });

    return {
      indecisionActive,
      confidenceScore,
      rationale,
    };
  }


  /**
   * Calcula confidence combinado para detecção de indecisão.
   * 
   * Combina múltiplos sinais de indecisão usando média ponderada:
   * - Padrões detectados (30%): número de padrões semânticos detectados
   * - Estabilidade (20%): estabilidade da categoria dominante
   * - Força da tendência (15%): quão forte é a tendência estável
   * - Volume de dados (15%): quantidade de chunks analisados
   * - Proporção de indecisão (10%): % de categorias de indecisão
   * - Consistência temporal (10%): se padrão se mantém ao longo do tempo
   * 
   * @param state Estado do participante contendo análise de texto
   * @param patterns Padrões semânticos detectados
   * @param temporalConsistency Consistência temporal do padrão
   * @returns Valor de confidence entre 0.0 e 1.0
   * 
   * @example
   * ```typescript
   * const patterns = this.detectIndecisionPatterns(state);
   * const consistency = this.calculateTemporalConsistency(state, now);
   * const confidence = this.calculateIndecisionConfidence(state, patterns, consistency);
   * // confidence será entre 0.0 e 1.0
   * ```
   */


  private inCooldown(state: ParticipantState, type: string, now: number): boolean {
    const until = state.cooldownUntilByType.get(type);
    return typeof until === 'number' && until > now;
  }

  private cooldownRemainingMs(state: ParticipantState, type: string, now: number): number {
    const until = state.cooldownUntilByType.get(type);
    if (typeof until !== 'number') return 0;
    return Math.max(0, until - now);
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
    now: number,
    windowMs: number = 60000, // Últimos 60 segundos
    maxPhrases: number = 5,
    minConfidence: number = 0.01 // 🧪 TESTE: Reduzido de 0.6 para 0.01
  ): string[] {
    const textHistory = state.textAnalysis?.textHistory ?? [];
    if (textHistory.length === 0) {
      return [];
    }

    const cutoffTime = now - windowMs;
    const indecisionCategories = ['stalling', 'objection_soft'];

    // Filtrar textos de indecisão dentro da janela temporal
    const indecisionTexts = textHistory
      .filter(entry => {
        // Verificar timestamp (deve estar dentro da janela temporal)
        if (entry.timestamp < cutoffTime) {
          return false;
        }

        // Verificar categoria (deve ser stalling ou objection_soft)
        if (!entry.sales_category || !indecisionCategories.includes(entry.sales_category)) {
          return false;
        }

        // Verificar confiança mínima
        if ((entry.sales_category_confidence ?? 0) < minConfidence) {
          return false;
        }

        return true;
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