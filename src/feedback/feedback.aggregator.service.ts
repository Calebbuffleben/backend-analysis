import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FeedbackDeliveryService } from './feedback.delivery.service';
import { FeedbackEventPayload, FeedbackIngestionEvent } from './feedback.types';
import { ParticipantIndexService } from '../livekit/participant-index.service';
import { runA2E2Pipeline } from './a2e2/pipeline/run-a2e2-pipeline';
import { runTextAnalysisPipeline } from './a2e2/pipeline/run-text-analysis-pipeline';
import { TextAnalysisResult } from '../pipeline/text-analysis.service';
import type { DetectionContext, TextHistoryEntry } from './a2e2/types';
import { makeFeedbackId } from './utils/id';
import { truncateWithEllipsis } from './utils/snippet';
import { textSimilar } from './utils/text-similarity';

type Sample = {
  ts: number;
  speech: boolean;
  valence?: number;
  arousal?: number;
  rmsDbfs?: number;
  emotions?: Record<string, number>;
};

type ParticipantState = {
  samples: Sample[]; // pruned to last 65s
  ema: {
    valence?: number;
    arousal?: number;
    rms?: number;
    emotions: Map<string, number>; // EMA per specific emotion
  };
  cooldownUntilByType: Map<string, number>;
  lastFeedbackAt?: number;
  lastFeedbackText?: string;
  lastFeedbackTextAt?: number;
  // NOVO: Dados de análise de texto
  textAnalysis?: {
    sentiment: {
      positive: number;
      negative: number;
      neutral: number;
    };
    keywords: string[];
    hasQuestion: boolean;
    lastUpdate?: number;
    // Novos campos da análise
    intent?: string;
    intent_confidence?: number;
    topic?: string;
    topic_confidence?: number;
    speech_act?: string;
    speech_act_confidence?: number;
    entities?: string[];
    sentiment_label?: string; // 'positive' | 'negative' | 'neutral'
    sentiment_score?: number; // Score único
    urgency?: number;
    embedding?: number[];
    /**
     * Categoria de vendas detectada usando análise semântica com SBERT.
     * 
     * Categorias possíveis:
     * - 'price_interest': Cliente demonstra interesse em saber o preço
     * - 'value_exploration': Cliente explora o valor e benefícios da solução
     * - 'objection_soft': Objeções leves, dúvidas ou hesitações
     * - 'objection_hard': Objeções fortes e definitivas, rejeição clara
     * - 'decision_signal': Sinais claros de que o cliente está pronto para decidir
     * - 'information_gathering': Cliente busca informações adicionais
     * - 'stalling': Cliente está protelando ou adiando a decisão
     * - 'closing_readiness': Cliente demonstra prontidão para fechar o negócio
     * 
     * undefined se nenhuma categoria foi detectada com confiança suficiente ou se SBERT não estiver configurado.
     */
    sales_category?: string | null;
    /**
     * Confiança da classificação de categoria de vendas (0.0 a 1.0).
     * 
     * Calculada baseada na diferença entre a melhor categoria e a segunda melhor,
     * considerando também o score absoluto da melhor categoria.
     * 
     * undefined se sales_category for undefined/null.
     */
    sales_category_confidence?: number | null;
    /**
     * Intensidade do sinal semântico (0.0 a 1.0).
     * 
     * Score absoluto da melhor categoria, diferente de confiança.
     * Representa quão forte é o match semântico, independente da diferença
     * entre categorias. Útil para diferenciar entre match fraco mas claro
     * vs match forte.
     * 
     * undefined se sales_category for undefined/null.
     */
    sales_category_intensity?: number | null;
    /**
     * Ambiguidade semântica (0.0 a 1.0).
     * 
     * 0.0 = claro (uma categoria dominante)
     * 1.0 = muito ambíguo (scores muito próximos entre categorias)
     * 
     * Calculado usando entropia normalizada dos scores.
     * Textos ambíguos podem ter múltiplas interpretações válidas.
     * 
     * undefined se sales_category for undefined/null.
     */
    sales_category_ambiguity?: number | null;
    /**
     * Flags semânticas booleanas que facilitam heurísticas no backend.
     * 
     * Flags disponíveis:
     * - price_window_open: True se há janela de oportunidade para falar sobre preço
     * - decision_signal_strong: True se há sinal forte de que cliente está pronto para decidir
     * - ready_to_close: True se cliente demonstra prontidão para fechar o negócio
     * 
     * undefined se sales_category for undefined/null ou se nenhuma flag estiver ativa.
     */
    sales_category_flags?: {
      price_window_open?: boolean;
      decision_signal_strong?: boolean;
      ready_to_close?: boolean;
      indecision_detected?: boolean;
      decision_postponement_signal?: boolean;
      conditional_language_signal?: boolean;
    } | null;
    /**
     * Score absoluto da melhor categoria (0.0 a 1.0).
     */
    sales_category_best_score?: number;
    /**
     * Scores de todas as categorias (debug/diagnóstico).
     */
    sales_category_scores?: Record<string, number>;
    /**
     * Top 3 categorias com scores (debug/diagnóstico).
     */
    sales_category_top_3?: Array<{ category: string; score: number }>;
    /**
     * Agregação temporal de categorias baseada em janela de contexto.
     */
    sales_category_aggregated?: {
      dominant_category?: string;
      category_distribution?: Record<string, number>;
      stability?: number;
      total_chunks?: number;
      chunks_with_category?: number;
    } | null;
    /**
     * Transição de categoria detectada baseada em histórico.
     */
    sales_category_transition?: {
      transition_type?: 'advancing' | 'regressing' | 'lateral';
      from_category?: string;
      to_category?: string;
      confidence?: number;
      time_delta_ms?: number;
      from_stage?: number;
      to_stage?: number;
      stage_difference?: number;
    } | null;
    /**
     * Tendência semântica da conversa ao longo do tempo.
     */
    sales_category_trend?: {
      trend?: 'advancing' | 'stable' | 'regressing';
      trend_strength?: number;
      current_stage?: number;
      velocity?: number;
    } | null;
    /**
     * Keywords condicionais detectadas no texto.
     * 
     * Lista de palavras e frases que indicam linguagem condicional ou hesitação,
     * característica de clientes indecisos.
     */
    conditional_keywords_detected?: string[];
    /**
     * Métricas específicas de indecisão pré-calculadas.
     * 
     * Métricas calculadas no Python para facilitar análise no backend.
     */
    indecision_metrics?: {
      indecision_score?: number;
      postponement_likelihood?: number;
      conditional_language_score?: number;
    } | null;
    /**
     * Histórico de textos analisados recentemente.
     * 
     * Mantém últimos N textos (padrão: 20) para permitir:
     * - Extração de frases representativas
     * - Análise temporal de padrões
     * - Detecção de consistência ao longo do tempo
     * 
     * Cada entrada contém o texto original, timestamp e campos
     * relevantes de sales_category para análise posterior.
     */
    textHistory?: TextHistoryEntry[];
  };
};

/**
 * Thresholds usados pelo agregador para janelas e EMA.
 * Detecção de emoções/prosódia/longo-prazo está em ./a2e2/ (runA2E2Pipeline).
 */
const THRESHOLDS = {
  windows: {
    short: 3000, // 3s
    long: 10000, // 10s
    prune: 65000, // 65s
  },
  ema: {
    alpha: 0.3,
  },
};

@Injectable()
export class FeedbackAggregatorService {
  private readonly logger = new Logger(FeedbackAggregatorService.name);
  private readonly byKey = new Map<string, ParticipantState>(); // key = meetingId:participantId
  /** Serializes handleTextAnalysis per participant so cooldown set by one event is visible to the next. */
  private readonly textAnalysisLockByKey = new Map<string, Promise<void>>();
  private readonly shortWindowMs = THRESHOLDS.windows.short;
  private readonly longWindowMs = THRESHOLDS.windows.long;
  private readonly pruneHorizonMs = THRESHOLDS.windows.prune;
  private readonly emaAlpha = THRESHOLDS.ema.alpha;
  
  // Meeting-level tracking for interruptions and cooldowns
  private readonly overlapHistoryByMeeting = new Map<string, number[]>(); // timestamps for overlap detections
  private readonly lastOverlapSampleAtByMeeting = new Map<string, number>(); // throttle overlap sampling
  private readonly meetingCooldownByType = new Map<string, number>(); // key=`${meetingId}:${type}` -> until timestamp
  private readonly lastSpeakerByMeeting = new Map<string, string>(); // meetingId -> participantId
  private readonly postInterruptionCandidatesByMeeting = new Map<
    string,
    Array<{ ts: number; interruptedId: string; valenceBefore?: number }>
  >();

  constructor(
    private readonly delivery: FeedbackDeliveryService,
    private readonly index: ParticipantIndexService,
  ) {
    // FASE 2: Validação - confirmar que handlers @OnEvent estão sendo registrados
    this.logger.log(`[EVENT_EMITTER] FeedbackAggregatorService initialized with @OnEvent handlers`);
    this.logger.debug(`[EVENT_EMITTER] Service instance created, handlers will be registered by NestJS`);
  }

  @OnEvent('feedback.ingestion', { async: true })
  handleIngestion(evt: FeedbackIngestionEvent): void {
    const participantId = evt.participantId ?? '';
    if (!participantId) return;
    const includeHost = (process.env.FEEDBACK_INCLUDE_HOST || 'false') === 'true';
    if (evt.participantRole === 'host' && !includeHost) {
      return;
    }
    const key = this.key(evt.meetingId, participantId);
    const state = this.byKey.get(key) ?? this.initState();
    const sample: Sample = {
      ts: evt.ts,
      speech: evt.prosody.speechDetected,
      valence: evt.prosody.valence,
      arousal: evt.prosody.arousal,
      rmsDbfs: evt.signal?.rmsDbfs,
      emotions: evt.prosody.emotions,
    };
    
    // DEBUG: Log incoming emotions BEFORE EMA
    if (sample.emotions && Object.keys(sample.emotions).length > 0) {
      const top3 = Object.entries(sample.emotions)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, score]) => `${name}:${score.toFixed(3)}`)
        .join(', ');
      this.logger.log(`[INGESTION] ${participantId}: Received ${Object.keys(sample.emotions).length} emotions. Top 3: ${top3}, speech=${sample.speech}`);
    }
    
    state.samples.push(sample);
    this.pruneOld(state, evt.ts);
    this.updateEma(state, sample);
    this.byKey.set(key, state);

    // DEBUG: Log emotion EMA state periodically
    if (state.samples.length % 20 === 0 && state.ema.emotions.size > 0) {
      const top5 = Array.from(state.ema.emotions.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, score]) => `${name}:${score.toFixed(3)}`)
        .join(', ');
      this.logger.log(`[EMA] ${participantId}: ${state.ema.emotions.size} emotions tracked. Top 5: ${top5}`);
    }

    // ===================================================================
    // ARQUITETURA EMOCIONAL 2.0 (A2E2) - Pipeline Hierárquico
    // ===================================================================
    // IMPORTANTE: A aplicação usa a pipeline modular A2E2, não as heurísticas antigas.
    // A pipeline está em: ./a2e2/pipeline/run-a2e2-pipeline.ts
    // 
    // Prioridade absoluta: Camada 1 > Camada 2 > Camada 3 > Camada 4
    // Cada camada só executa se as anteriores não retornaram feedback
    
    // Atualizar tracking de oradores (necessário para camadas 2 e 4)
    this.updateSpeakerTracking(evt.meetingId, evt.ts);
    
    // Criar contexto para a pipeline A2E2
    const ctx = this.createDetectionContext(evt.meetingId, participantId, evt.ts);

    // Executar pipeline A2E2
    const feedback = runA2E2Pipeline(state, ctx);
    if (feedback) {
      this.delivery.publishToHosts(evt.meetingId, feedback);
    }
  }

  @OnEvent('text.analysis', { async: true })
  async handleTextAnalysis(evt: TextAnalysisResult): Promise<void> {
    const t8_handler_start = Date.now();

    // Filtro rápido: descartar textos de UI/CTA do Google Meet para não poluir histórico nem detecção.
    const textLower = (evt.text || '').toLowerCase();
    const isMeetUiText =
      textLower.includes('teste os recursos premium do google meet') ||
      textLower.includes('voltando à tela inicial em 60 segundos') ||
      textLower.includes('sua reunião está pronta') ||
      textLower.includes('closefecharperson_add') ||
      /\\d+\\s*(segundos?|minutos?)\\s*restantes?/i.test(textLower);

    if (isMeetUiText) {
      this.logger.debug('🧹 [TEXT_ANALYSIS] Ignoring Google Meet UI/CTA text', {
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        textPreview: evt.text.substring(0, 80),
      });
      return;
    }

    this.logger.log('✅ [SANITY] handleTextAnalysis() called - handler is registered and working', {
      meetingId: evt.meetingId,
      participantId: evt.participantId,
      source: evt.source ?? 'unknown',
      textLength: evt.text?.length ?? 0,
      textPreview: evt.text?.substring(0, 50) ?? 'null',
      hasSalesCategory: !!evt.analysis?.sales_category,
      salesCategory: evt.analysis?.sales_category ?? 'null',
    });

    const participantId = evt.participantId ?? '';
    const key = this.key(evt.meetingId, participantId);
    let state = this.byKey.get(key);
    if (!state) {
      this.logger.warn(`No state found for ${key}, creating new state`);
      state = this.initState();
      this.byKey.set(key, state);
    }

    // Serialize per participant so cooldown set by one event is visible to the next (prevents indecision loop).
    const prev = this.textAnalysisLockByKey.get(key) ?? Promise.resolve();
    const ourRun = prev.then(() => this.runHandleTextAnalysisCore(evt, key, participantId, t8_handler_start));
    this.textAnalysisLockByKey.set(key, ourRun);
    await ourRun;
  }

  private async runHandleTextAnalysisCore(
    evt: TextAnalysisResult,
    key: string,
    participantId: string,
    t8_handler_start: number,
  ): Promise<void> {
    const state = this.byKey.get(key);
    if (!state) return;
    const now = evt.timestamp;

    if (evt.analysis.sales_category) {
      const flagsInfo = evt.analysis.sales_category_flags
        ? Object.entries(evt.analysis.sales_category_flags)
            .filter(([, value]) => value === true)
            .map(([k]) => k)
            .join(', ')
        : '';
      this.logger.log(
        `💼 [SALES CATEGORY] Processing sales category: ${evt.analysis.sales_category}${flagsInfo ? ` [Flags: ${flagsInfo}]` : ''}`,
        {
          meetingId: evt.meetingId,
          participantId: evt.participantId,
          sales_category: evt.analysis.sales_category,
          sales_category_confidence: evt.analysis.sales_category_confidence,
          sales_category_intensity: evt.analysis.sales_category_intensity,
          sales_category_ambiguity: evt.analysis.sales_category_ambiguity,
          sales_category_flags: evt.analysis.sales_category_flags,
          text_preview: evt.text.substring(0, 50),
          sentiment: evt.analysis.sentiment,
          intent: evt.analysis.intent,
          topic: evt.analysis.topic,
        },
      );
    }

    this.updateStateWithTextAnalysis(state, evt);

    const SPEECH_SEGMENT_WINDOW_MS = 30_000;
    const timeSinceLastTextFeedback = typeof state.lastFeedbackTextAt === 'number'
      ? now - state.lastFeedbackTextAt
      : Infinity;
    const lastText = (state.lastFeedbackText ?? '').trim();
    const currentText = (evt.text ?? '').trim();
    const isSameSegmentBySimilarity = lastText && currentText && textSimilar(state.lastFeedbackText!, evt.text);
    const isSameSegmentByContainment =
      lastText && currentText && currentText.toLowerCase().includes(lastText.toLowerCase());
    if (
      timeSinceLastTextFeedback < SPEECH_SEGMENT_WINDOW_MS &&
      state.lastFeedbackText &&
      (isSameSegmentBySimilarity || isSameSegmentByContainment)
    ) {
      this.logger.debug('🔇 [SPEECH_DEDUPE] Same speech segment — skipping feedback generation', {
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        timeSinceLastTextFeedbackMs: timeSinceLastTextFeedback,
        reason: isSameSegmentByContainment ? 'containment' : 'similarity',
      });
      return;
    }

    const ctx = this.createDetectionContext(evt.meetingId, participantId, now);
    const feedback = runA2E2Pipeline(state, ctx);
    if (feedback) {
      this.delivery.publishToHosts(evt.meetingId, feedback);
    }

    const salesFeedback = this.generateSalesFeedback(state, evt, now);
    if (salesFeedback) {
      this.delivery.publishToHosts(evt.meetingId, salesFeedback);
    }

    let salesTextAnalysisFeedback = runTextAnalysisPipeline(state, ctx);
    // Optional: only publish indecision feedback when source is buffer (avoids egress amplifying firing).
    const indecisionSourceOnly = process.env.SALES_CLIENT_INDECISION_SOURCE_ONLY || '';
    if (
      salesTextAnalysisFeedback?.type === 'sales_client_indecision' &&
      indecisionSourceOnly === 'buffer' &&
      evt.source === 'egress'
    ) {
      salesTextAnalysisFeedback = null;
      this.logger.debug('🔇 [INDECISION_SOURCE] Dropping indecision feedback from egress (SALES_CLIENT_INDECISION_SOURCE_ONLY=buffer)', {
        meetingId: evt.meetingId,
        participantId: evt.participantId,
      });
    }
    // Optional: only publish solution-understood feedback when source is buffer (same pattern as indecision).
    const solutionUnderstoodSourceOnly = process.env.SALES_SOLUTION_UNDERSTOOD_SOURCE_ONLY || '';
    if (
      salesTextAnalysisFeedback?.type === 'sales_solution_understood' &&
      solutionUnderstoodSourceOnly === 'buffer' &&
      evt.source === 'egress'
    ) {
      salesTextAnalysisFeedback = null;
      this.logger.debug('🔇 [SOLUTION_UNDERSTOOD_SOURCE] Dropping solution-understood feedback from egress (SALES_SOLUTION_UNDERSTOOD_SOURCE_ONLY=buffer)', {
        meetingId: evt.meetingId,
        participantId: evt.participantId,
      });
    }
    if (salesTextAnalysisFeedback) {
      this.delivery.publishToHosts(evt.meetingId, salesTextAnalysisFeedback);
      const serverNow = Date.now();
      // Defense-in-depth: set indecision cooldown at aggregator (server time).
      if (salesTextAnalysisFeedback.type === 'sales_client_indecision') {
        const raw = process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS;
        const indecisionCooldownMs = raw ? Math.max(0, Number.parseInt(raw, 10)) : 120_000;
        if (Number.isFinite(indecisionCooldownMs) && indecisionCooldownMs > 0) {
          state.cooldownUntilByType.set('sales_client_indecision', serverNow + indecisionCooldownMs);
          state.lastFeedbackAt = serverNow;
        }
      }
      // Defense-in-depth: set solution-understood cooldown at aggregator (server time).
      if (salesTextAnalysisFeedback.type === 'sales_solution_understood') {
        const raw = process.env.SALES_SOLUTION_UNDERSTOOD_COOLDOWN_MS;
        const solutionCooldownMs = raw ? Math.max(0, Number.parseInt(raw, 10)) : 120_000;
        if (Number.isFinite(solutionCooldownMs) && solutionCooldownMs > 0) {
          state.cooldownUntilByType.set('sales_solution_understood', serverNow + solutionCooldownMs);
          state.lastFeedbackAt = serverNow;
        }
      }
    }

    if (feedback || salesFeedback || salesTextAnalysisFeedback) {
      state.lastFeedbackText = evt.text;
      state.lastFeedbackTextAt = now;
    }

    const t9_feedback_generated = Date.now();
    const timing = (evt as any).timing;
    const t0_capture = timing?.t0_capture || evt.timestamp;
    this.logger.log(`[LATENCY] Feedback pipeline complete`, {
      meetingId: evt.meetingId,
      participantId: evt.participantId,
      timestamps: { t0_capture, t8_handler_start, t9_complete: t9_feedback_generated },
      latencies_ms: {
        handler_processing: t9_feedback_generated - t8_handler_start,
        end_to_end_total: t9_feedback_generated - t0_capture,
      },
      feedbacks_generated: { a2e2: !!feedback, sales: !!salesFeedback, text_analysis: !!salesTextAnalysisFeedback },
    });
  }

  private updateStateWithTextAnalysis(
    state: ParticipantState,
    evt: TextAnalysisResult,
  ): void {
    // ========================================================================
    // FASE 1: ARMAZENAMENTO DE HISTÓRICO DE TEXTOS
    // ========================================================================
    // Mantém histórico dos últimos 20 textos analisados para permitir:
    // - Extração de frases representativas
    // - Análise temporal de padrões
    // - Detecção de consistência ao longo do tempo
    // ========================================================================
    const maxHistorySize = 20;
    
    // Criar entrada no histórico
    const historyEntry: TextHistoryEntry = {
      text: evt.text,
      timestamp: evt.timestamp,
      received_at: Date.now(),
      sales_category: evt.analysis.sales_category ?? null,
      sales_category_confidence: evt.analysis.sales_category_confidence ?? null,
      sales_category_intensity: evt.analysis.sales_category_intensity ?? null,
      sales_category_ambiguity: evt.analysis.sales_category_ambiguity ?? null,
      embedding: evt.analysis.embedding ?? undefined,
      keywords: evt.analysis.keywords ?? undefined,
    };
    
    // FASE 1: Log detalhado quando chunk é adicionado ao textHistory
    if (historyEntry.sales_category) {
      this.logger.debug('📝 [TEXT_HISTORY] Adding entry with sales_category to history', {
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        text_preview: historyEntry.text.substring(0, 50),
        sales_category: historyEntry.sales_category,
        sales_category_confidence: historyEntry.sales_category_confidence,
        sales_category_intensity: historyEntry.sales_category_intensity,
        sales_category_ambiguity: historyEntry.sales_category_ambiguity,
        timestamp: historyEntry.timestamp,
      });
    } else {
      this.logger.debug('📝 [TEXT_HISTORY] Adding entry WITHOUT sales_category to history', {
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        text_preview: historyEntry.text.substring(0, 50),
        sales_category: null,
        timestamp: historyEntry.timestamp,
      });
    }
    
    // Inicializar histórico se não existir
    const currentHistory = state.textAnalysis?.textHistory ?? [];
    
    // Adicionar nova entrada ao histórico
    const updatedHistory = [...currentHistory, historyEntry];
    
    // Manter apenas últimos N textos (limitar tamanho do histórico)
    const prunedHistory = updatedHistory.length > maxHistorySize
      ? updatedHistory.slice(-maxHistorySize)
      : updatedHistory;
    
    // FASE 1: Log resumo do histórico após adição
    const historyWithCategory = prunedHistory.filter(entry => entry.sales_category).length;
    this.logger.debug('📝 [TEXT_HISTORY] History updated', {
      meetingId: evt.meetingId,
      participantId: evt.participantId,
      totalEntries: prunedHistory.length,
      entriesWithCategory: historyWithCategory,
      lastEntryCategory: prunedHistory[prunedHistory.length - 1]?.sales_category ?? null,
      lastEntryConfidence: prunedHistory[prunedHistory.length - 1]?.sales_category_confidence ?? null,
    });
    
    // FASE 2: Validação de integridade do textHistory
    // Garantir que o chunk atual foi adicionado corretamente ao histórico
    const lastEntry = prunedHistory[prunedHistory.length - 1];
    const isCurrentChunkInHistory = lastEntry && 
      lastEntry.text === evt.text && 
      lastEntry.timestamp === evt.timestamp;
    
    if (!isCurrentChunkInHistory) {
      this.logger.warn('⚠️ [TEXT_HISTORY] Current chunk not found in history!', {
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        expectedText: evt.text.substring(0, 50),
        expectedTimestamp: evt.timestamp,
        lastEntryText: lastEntry?.text?.substring(0, 50) ?? 'null',
        lastEntryTimestamp: lastEntry?.timestamp ?? null,
        historyLength: prunedHistory.length,
      });
    } else {
      this.logger.debug('✅ [TEXT_HISTORY] Current chunk verified in history', {
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        historyLength: prunedHistory.length,
        hasSalesCategory: !!lastEntry.sales_category,
      });
    }
    
    // FASE 2: Validação de sincronização - garantir que sales_category do chunk atual
    // está consistente entre o evento e o histórico
    if (lastEntry && lastEntry.sales_category !== (evt.analysis.sales_category ?? null)) {
      this.logger.warn('⚠️ [TEXT_HISTORY] Sales category mismatch between event and history!', {
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        eventSalesCategory: evt.analysis.sales_category ?? null,
        historySalesCategory: lastEntry.sales_category ?? null,
        eventConfidence: evt.analysis.sales_category_confidence ?? null,
        historyConfidence: lastEntry.sales_category_confidence ?? null,
      });
    }
    
    // ========================================================================
    // Atualizar estado com análise de texto e histórico
    // ========================================================================
    state.textAnalysis = {
      sentiment: {
        positive: evt.analysis.sentiment === 'positive' ? evt.analysis.sentiment_score : 0,
        negative: evt.analysis.sentiment === 'negative' ? evt.analysis.sentiment_score : 0,
        neutral: evt.analysis.sentiment === 'neutral' ? evt.analysis.sentiment_score : 0,
      },
      keywords: evt.analysis.keywords,
      hasQuestion: evt.analysis.speech_act === 'question',
      lastUpdate: evt.timestamp,
      // Novos campos
      intent: evt.analysis.intent,
      intent_confidence: evt.analysis.intent_confidence,
      topic: evt.analysis.topic,
      topic_confidence: evt.analysis.topic_confidence,
      speech_act: evt.analysis.speech_act,
      speech_act_confidence: evt.analysis.speech_act_confidence,
      entities: evt.analysis.entities,
      sentiment_label: evt.analysis.sentiment,
      sentiment_score: evt.analysis.sentiment_score,
      urgency: evt.analysis.urgency,
      embedding: evt.analysis.embedding,
      // Categorias de vendas classificadas com SBERT
      // Estes campos são opcionais e podem ser null se SBERT não estiver configurado
      // ou se nenhuma categoria foi detectada com confiança suficiente
      sales_category: evt.analysis.sales_category ?? undefined,
      sales_category_confidence: evt.analysis.sales_category_confidence ?? undefined,
      sales_category_intensity: evt.analysis.sales_category_intensity ?? undefined,
      sales_category_ambiguity: evt.analysis.sales_category_ambiguity ?? undefined,
      sales_category_flags: evt.analysis.sales_category_flags ?? undefined,
      sales_category_best_score: evt.analysis.sales_category_best_score ?? undefined,
      sales_category_scores: evt.analysis.sales_category_scores ?? undefined,
      sales_category_top_3: evt.analysis.sales_category_top_3 ?? undefined,
      // Análises contextuais (baseadas em histórico)
      sales_category_aggregated: evt.analysis.sales_category_aggregated ?? undefined,
      sales_category_transition: evt.analysis.sales_category_transition ?? undefined,
      sales_category_trend: evt.analysis.sales_category_trend ?? undefined,
      // Keywords condicionais detectadas (FASE 9)
      conditional_keywords_detected: evt.analysis.conditional_keywords_detected ?? undefined,
      // Métricas de indecisão (FASE 10)
      indecision_metrics: evt.analysis.indecision_metrics ?? undefined,
      // Histórico de textos (FASE 1)
      textHistory: prunedHistory,
    };

    // Log detalhado da atualização do estado
    const logData: Record<string, unknown> = {
      intent: evt.analysis.intent,
      intent_confidence: evt.analysis.intent_confidence,
      topic: evt.analysis.topic,
      topic_confidence: evt.analysis.topic_confidence,
      speech_act: evt.analysis.speech_act,
      speech_act_confidence: evt.analysis.speech_act_confidence,
      sentiment: evt.analysis.sentiment,
      sentiment_score: evt.analysis.sentiment_score,
      urgency: evt.analysis.urgency,
      entities: evt.analysis.entities,
      keywords: evt.analysis.keywords.slice(0, 5),
      embedding_dim: evt.analysis.embedding.length,
    };

    // Adicionar sales_category ao log se presente (destacar visualmente)
    if (evt.analysis.sales_category) {
      logData.sales_category = evt.analysis.sales_category;
      logData.sales_category_confidence = evt.analysis.sales_category_confidence;
      logData.sales_category_intensity = evt.analysis.sales_category_intensity;
      logData.sales_category_ambiguity = evt.analysis.sales_category_ambiguity;
      logData.sales_category_flags = evt.analysis.sales_category_flags;
      
      // Construir mensagem detalhada com flags ativas
      const flagsInfo = evt.analysis.sales_category_flags
        ? Object.entries(evt.analysis.sales_category_flags)
            .filter(([, value]) => value === true)
            .map(([key]) => key)
            .join(', ')
        : '';
      const flagsText = flagsInfo ? ` [Flags: ${flagsInfo}]` : '';
      
      // Log em nível INFO quando sales_category está presente (mais visível)
      this.logger.log(
        `✅ [TEXT ANALYSIS] Updated with sales category: ${evt.analysis.sales_category} (conf: ${(evt.analysis.sales_category_confidence ?? 0).toFixed(2)}, intensity: ${(evt.analysis.sales_category_intensity ?? 0).toFixed(2)}, ambiguity: ${(evt.analysis.sales_category_ambiguity ?? 0).toFixed(2)})${flagsText}`,
        {
          meetingId: evt.meetingId,
          participantId: evt.participantId,
          ...logData,
        },
      );
    } else {
      // Log em nível DEBUG quando sales_category não está presente
      this.logger.debug(
        `Updated text analysis for ${evt.meetingId}/${evt.participantId}`,
        {
          meetingId: evt.meetingId,
          participantId: evt.participantId,
          ...logData,
          sales_category: null,
          sales_category_confidence: null,
          sales_category_intensity: null,
          sales_category_ambiguity: null,
          sales_category_flags: null,
        },
      );
    }
  }

  private createDetectionContext(
    meetingId: string,
    participantId: string,
    now: number,
  ): DetectionContext {
    return {
      meetingId,
      participantId,
      now,
      getParticipantName: (mid: string, pid: string) => this.index.getParticipantName(mid, pid),
      getParticipantRole: (mid: string, pid: string) => this.index.getParticipantRole(mid, pid),
      inCooldown: (st: ParticipantState, type: string, n: number) => this.inCooldown(st, type, n),
      inGlobalCooldown: (st: ParticipantState, n: number) => this.inGlobalCooldown(st, n),
      setCooldown: (st: ParticipantState, type: string, n: number, ms: number) =>
        this.setCooldown(st, type, n, ms),
      inCooldownMeeting: (mid: string, type: string, n: number) =>
        this.inCooldownMeeting(mid, type, n),
      setCooldownMeeting: (mid: string, type: string, n: number, ms: number) =>
        this.setCooldownMeeting(mid, type, n, ms),
      makeId: () => this.makeId(),
      window: (st: ParticipantState, n: number, ms: number) => this.window(st, n, ms),
      getParticipantsForMeeting: (mid: string) => this.participantsForMeeting(mid),
      getParticipantState: (mid: string, pid: string) => {
        const k = this.key(mid, pid);
        return this.byKey.get(k);
      },
      getPostInterruptionCandidates: (mid: string) =>
        this.postInterruptionCandidatesByMeeting.get(mid),
      updatePostInterruptionCandidates: (mid: string, candidates: Array<{ ts: number; interruptedId: string; valenceBefore?: number }>) => {
        this.postInterruptionCandidatesByMeeting.set(mid, candidates);
      },
      getOverlapHistory: (mid: string) => this.overlapHistoryByMeeting.get(mid),
      updateOverlapHistory: (mid: string, timestamps: number[]) => {
        this.overlapHistoryByMeeting.set(mid, timestamps);
      },
      getLastOverlapSampleAt: (mid: string) => this.lastOverlapSampleAtByMeeting.get(mid),
      setLastOverlapSampleAt: (mid: string, timestamp: number) => {
        this.lastOverlapSampleAtByMeeting.set(mid, timestamp);
      },
    };
  }

  // ===================================================================
  // HELPERS
  // ===================================================================

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

  private pruneOld(state: ParticipantState, now: number): void {
    const minTs = now - this.pruneHorizonMs;
    while (state.samples.length > 0 && state.samples[0].ts < minTs) {
      state.samples.shift();
    }
  }

  private updateEma(state: ParticipantState, s: Sample): void {
    const a = this.emaAlpha;
    if (typeof s.valence === 'number') {
      state.ema.valence =
        typeof state.ema.valence === 'number'
          ? a * s.valence + (1 - a) * state.ema.valence
          : s.valence;
    }
    if (typeof s.arousal === 'number') {
      state.ema.arousal =
        typeof state.ema.arousal === 'number'
          ? a * s.arousal + (1 - a) * state.ema.arousal
          : s.arousal;
    }
    if (typeof s.rmsDbfs === 'number') {
      state.ema.rms =
        typeof state.ema.rms === 'number' ? a * s.rmsDbfs + (1 - a) * state.ema.rms : s.rmsDbfs;
    }
    if (s.emotions) {
      for (const [name, score] of Object.entries(s.emotions)) {
        const key = name.toLowerCase();
        const prev = state.ema.emotions.get(key);
        const next = typeof prev === 'number' ? a * score + (1 - a) * prev : score;
        state.ema.emotions.set(key, next);
      }
    }
  }

  private updateSpeakerTracking(meetingId: string, now: number): void {
    const participants = this.participantsForMeeting(meetingId);
    if (participants.length === 0) return;
    let topId: string | undefined;
    let topCov = 0;
    let secondCov = 0;
    for (const [pid, st] of participants) {
      const w = this.window(st, now, this.shortWindowMs);
      if (w.samplesCount === 0) continue;
      const cov = w.speechCount / w.samplesCount;
      if (cov > topCov) {
        secondCov = topCov;
        topCov = cov;
        topId = pid;
      } else if (cov > secondCov) {
        secondCov = cov;
      }
    }
    if (topId && topCov >= 0.5 && secondCov < 0.2) {
      this.lastSpeakerByMeeting.set(meetingId, topId);
    }
  }

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

  private inGlobalCooldown(state: ParticipantState, now: number, minGapMs = 2000): boolean {
    return typeof state.lastFeedbackAt === 'number' && now - state.lastFeedbackAt < minGapMs;
  }

  private initState(): ParticipantState {
    return {
      samples: [],
      ema: {
        emotions: new Map(),
      },
      cooldownUntilByType: new Map<string, number>(),
    };
  }

  private key(meetingId: string, participantId: string): string {
    return `${meetingId}:${participantId}`;
  }

  private makeId(): string {
    return makeFeedbackId();
  }

  private participantsForMeeting(meetingId: string): Array<[string, ParticipantState]> {
    const out: Array<[string, ParticipantState]> = [];
    const prefix = `${meetingId}:`;
    for (const [k, st] of this.byKey.entries()) {
      if (k.startsWith(prefix)) {
        const pid = k.slice(prefix.length);
        out.push([pid, st]);
      }
    }
    return out;
  }

  private inCooldownMeeting(meetingId: string, type: string, now: number): boolean {
    const key = `${meetingId}:${type}`;
    const until = this.meetingCooldownByType.get(key);
    return typeof until === 'number' && until > now;
  }

  private setCooldownMeeting(meetingId: string, type: string, now: number, ms: number): void {
    const key = `${meetingId}:${type}`;
    this.meetingCooldownByType.set(key, now + ms);
  }

  /**
   * Verifica se deve gerar feedback de vendas baseado em sinais semânticos.
   * 
   * Critérios:
   * - Cooldown global (30s)
   * - Flags fortes sempre geram feedback
   * - Consistência temporal mínima
   * - Confiança e intensidade adequadas
   * - Ambiguidade baixa
   */
  private shouldGenerateSalesFeedback(
    state: ParticipantState,
    evt: TextAnalysisResult,
    now: number,
  ): boolean {
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis?.sales_category) {
      return false;
    }

    // Verificar cooldown global (2 segundos, padrão de inGlobalCooldown)
    if (this.inGlobalCooldown(state, now)) {
      return false;
    }

    // Flags fortes sempre geram feedback (prioridade máxima)
    const flags = textAnalysis.sales_category_flags;
    if (flags) {
      if (flags.price_window_open || flags.decision_signal_strong || flags.ready_to_close) {
        return true;
      }
    }

    // Verificar confiança e intensidade mínimas
    const confidence = textAnalysis.sales_category_confidence ?? 0;
    const intensity = textAnalysis.sales_category_intensity ?? 0;
    if (confidence < 0.6 || intensity < 0.6) {
      return false;
    }

    // Verificar ambiguidade (muito ambíguo = não gerar feedback)
    const ambiguity = textAnalysis.sales_category_ambiguity ?? 1.0;
    if (ambiguity > 0.7) {
      return false;
    }

    // Verificar consistência temporal (se houver agregação)
    const aggregated = textAnalysis.sales_category_aggregated;
    if (aggregated) {
      const stability = aggregated.stability ?? 0;
      // Se histórico é muito instável (< 0.5), pode ser ruído
      if (stability < 0.5 && confidence < 0.8) {
        return false;
      }
    }

    return true;
  }

  /**
   * Gera feedback de vendas baseado em sinais semânticos.
   * 
   * Heurísticas implementadas:
   * 1. Janela de preço (price_window_open)
   * 2. Sinal forte de decisão (decision_signal_strong)
   * 3. Pronto para fechar (ready_to_close)
   * 4. Objeção escalando (transição regressiva)
   * 5. Conversa estagnada (tendência estável + stalling)
   * 6. Transições importantes (advancing/regressing)
   */
  private generateSalesFeedback(
    state: ParticipantState,
    evt: TextAnalysisResult,
    now: number,
  ): FeedbackEventPayload | null {
    if (!this.shouldGenerateSalesFeedback(state, evt, now)) {
      return null;
    }

    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      return null;
    }

    const flags = textAnalysis.sales_category_flags;
    const transition = textAnalysis.sales_category_transition;
    const trend = textAnalysis.sales_category_trend;
    const category = textAnalysis.sales_category;

    // Heurística 1: Janela de oportunidade para preço
    if (flags?.price_window_open && trend?.trend === 'advancing') {
      if (this.inCooldown(state, 'sales_price_window_open', now)) return null;
      const window = this.window(state, now, 30000);
      this.setCooldown(state, 'sales_price_window_open', now, 60000);
      return {
        id: this.makeId(),
        type: 'sales_price_window_open',
        severity: 'info',
        ts: now,
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        participantName: this.index.getParticipantName(evt.meetingId, evt.participantId) ?? undefined,
        window: { start: window.start, end: window.end },
        message: 'Agora é o momento ideal para apresentar o preço',
        tips: [
          'Cliente demonstrou interesse consistente em saber o preço',
          'Conversa progredindo positivamente',
          'Confiança alta na classificação',
          'Momento oportuno para discussão de valores',
        ],
        metadata: {
          sales_category: category ?? undefined,
          sales_category_confidence: textAnalysis.sales_category_confidence ?? undefined,
          sales_category_intensity: textAnalysis.sales_category_intensity ?? undefined,
        },
      };
    }

    // Heurística 2: Sinal forte de decisão
    if (flags?.decision_signal_strong) {
      if (this.inCooldown(state, 'sales_decision_signal', now)) return null;
      const window = this.window(state, now, 30000);
      this.setCooldown(state, 'sales_decision_signal', now, 60000);
      return {
        id: this.makeId(),
        type: 'sales_decision_signal',
        severity: 'info',
        ts: now,
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        participantName: this.index.getParticipantName(evt.meetingId, evt.participantId) ?? undefined,
        window: { start: window.start, end: window.end },
        message: 'Cliente demonstra sinais claros de prontidão para decidir',
        tips: [
          'Múltiplos sinais de decisão detectados',
          'Confiança muito alta na classificação',
          'Considerar acelerar processo de fechamento',
          'Apresentar próximos passos claramente',
        ],
        metadata: {
          sales_category: category ?? undefined,
          sales_category_confidence: textAnalysis.sales_category_confidence ?? undefined,
        },
      };
    }

    // Heurística 3: Pronto para fechar
    if (flags?.ready_to_close && trend?.current_stage && trend.current_stage >= 4) {
      if (this.inCooldown(state, 'sales_ready_to_close', now)) return null;
      const window = this.window(state, now, 30000);
      this.setCooldown(state, 'sales_ready_to_close', now, 60000);
      return {
        id: this.makeId(),
        type: 'sales_ready_to_close',
        severity: 'info',
        ts: now,
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        participantName: this.index.getParticipantName(evt.meetingId, evt.participantId) ?? undefined,
        window: { start: window.start, end: window.end },
        message: 'Cliente demonstra prontidão para fechar o negócio - acelerar processo',
        tips: [
          'Múltiplos sinais de fechamento detectados',
          'Conversa progredindo consistentemente',
          'Momento ideal para proposta final',
          'Evitar adicionar complexidade desnecessária',
        ],
        metadata: {
          sales_category: category ?? undefined,
          sales_category_confidence: textAnalysis.sales_category_confidence ?? undefined,
          current_stage: trend.current_stage,
        },
      };
    }

    // Heurística 4: Objeção escalando (transição regressiva)
    if (
      transition?.transition_type === 'regressing' &&
      transition.from_category === 'objection_soft' &&
      transition.to_category === 'objection_hard'
    ) {
      if (this.inCooldown(state, 'sales_objection_escalating', now)) return null;
      const window = this.window(state, now, 60000);
      this.setCooldown(state, 'sales_objection_escalating', now, 60000);
      return {
        id: this.makeId(),
        type: 'sales_objection_escalating',
        severity: 'warning',
        ts: now,
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        participantName: this.index.getParticipantName(evt.meetingId, evt.participantId) ?? undefined,
        window: { start: window.start, end: window.end },
        message: 'Objeção do cliente está piorando - requer abordagem diferente',
        tips: [
          'Cliente regrediu de objeção leve para forte',
          'Considerar mudança de estratégia imediata',
          'Focar em entender preocupações específicas',
          'Evitar ser defensivo ou insistente',
        ],
        metadata: {
          from_category: transition.from_category,
          to_category: transition.to_category,
          transition_confidence: transition.confidence,
        },
      };
    }

    // Heurística 5: Conversa estagnada
    if (
      trend?.trend === 'stable' &&
      trend.trend_strength &&
      trend.trend_strength > 0.9 &&
      category === 'stalling'
    ) {
      if (this.inCooldown(state, 'sales_conversation_stalling', now)) return null;
      const window = this.window(state, now, 60000);
      this.setCooldown(state, 'sales_conversation_stalling', now, 120000);
      return {
        id: this.makeId(),
        type: 'sales_conversation_stalling',
        severity: 'info',
        ts: now,
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        participantName: this.index.getParticipantName(evt.meetingId, evt.participantId) ?? undefined,
        window: { start: window.start, end: window.end },
        message: 'Conversa estagnada - considerar criar urgência',
        tips: [
          'Cliente protelando decisão consistentemente',
          'Considerar oferecer incentivo ou deadline',
          'Revisar valor proposto',
          'Identificar bloqueadores específicos',
        ],
        metadata: {
          sales_category: category,
          trend_strength: trend.trend_strength,
        },
      };
    }

    // Heurística 6: Transição importante (advancing)
    if (
      transition?.transition_type === 'advancing' &&
      transition.confidence &&
      transition.confidence > 0.7 &&
      transition.stage_difference &&
      transition.stage_difference >= 2
    ) {
      if (this.inCooldown(state, 'sales_category_transition', now)) return null;
      const window = this.window(state, now, 30000);
      this.setCooldown(state, 'sales_category_transition', now, 60000);
      return {
        id: this.makeId(),
        type: 'sales_category_transition',
        severity: 'info',
        ts: now,
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        participantName: this.index.getParticipantName(evt.meetingId, evt.participantId) ?? undefined,
        window: { start: window.start, end: window.end },
        message: `Cliente progrediu de ${this.getCategoryDisplayName(transition.from_category)} para ${this.getCategoryDisplayName(transition.to_category)}`,
        tips: [
          'Conversa avançando positivamente',
          'Aproveitar momento de progresso',
          'Manter momentum da conversa',
        ],
        metadata: {
          from_category: transition.from_category,
          to_category: transition.to_category,
          transition_confidence: transition.confidence,
          stage_difference: transition.stage_difference,
        },
      };
    }

    return null;
  }

  /**
   * Retorna nome amigável para categoria de vendas.
   */
  private getCategoryDisplayName(category: string | undefined | null): string {
    if (!category) return 'desconhecida';
    const names: Record<string, string> = {
      price_interest: 'interesse em preço',
      value_exploration: 'exploração de valor',
      objection_soft: 'objeção leve',
      objection_hard: 'objeção forte',
      decision_signal: 'sinal de decisão',
      information_gathering: 'coleta de informações',
      stalling: 'protelando',
      closing_readiness: 'pronto para fechar',
    };
    return names[category] || category;
  }

  // Debug/introspection
  getMeetingDebug(meetingId: string): {
    meetingId: string;
    participants: Array<{
      participantId: string;
      name?: string;
      speechCoverage10s: number;
      rmsMean3s?: number;
      emaRms?: number;
      samples: number;
    }>;
  } {
    const now = Date.now();
    const participants: Array<{
      participantId: string;
      name?: string;
      speechCoverage10s: number;
      rmsMean3s?: number;
      emaRms?: number;
      samples: number;
    }> = [];
    for (const [pid, st] of this.participantsForMeeting(meetingId)) {
      const w10 = this.window(st, now, this.longWindowMs);
      const w3 = this.window(st, now, this.shortWindowMs);
      const speechCoverage10s = w10.samplesCount > 0 ? w10.speechCount / w10.samplesCount : 0;
      participants.push({
        participantId: pid,
        name: this.index.getParticipantName(meetingId, pid) ?? undefined,
        speechCoverage10s,
        rmsMean3s: w3.meanRmsDbfs,
        emaRms: st.ema.rms,
        samples: st.samples.length,
      });
    }
    return { meetingId, participants };
  }
}
