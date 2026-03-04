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
 * Arquitetura Emocional 2.0 (A2E2) - Thresholds Centralizados
 * 
 * Todas as heurísticas seguem uma hierarquia rígida de prioridade:
 * 1. Camada 1: Emoções Primárias (maior prioridade)
 * 2. Camada 2: Meta-Estados Emocionais
 * 3. Camada 3: Sinais Prosódicos
 * 4. Camada 4: Estados de Longo Prazo (menor prioridade)
 */
const THRESHOLDS = {
  // Camada 1: Emoções Primárias
  primaryEmotion: {
    main: 0.05, // Threshold principal para emoções primárias
    dominant: 0.15, // Emoção dominante (muito maior que outras)
    rapidGrowth: 0.02, // Crescimento rápido do EMA
    hostility: {
      anger: 0.05,
      disgust: 0.05,
      distress: 0.05,
    },
    boredom: {
      boredom: 0.05,
      tiredness: 0.08,
      interestLow: 0.05, // Interest deve estar abaixo disso
    },
    confusion: {
      confusion: 0.05,
      doubt: 0.05,
    },
    positiveEngagement: {
      interest: 0.05,
      joy: 0.05,
      determination: 0.05,
    },
  },
  // Camada 2: Meta-Estados Emocionais
  meta: {
    frustrationTrend: {
      arousalDelta: 0.25, // Aumento de arousal
      valenceDelta: -0.2, // Queda de valence
    },
    postInterruption: {
      valenceDelta: -0.2, // Queda após interrupção
      minCoverage: 0.2,
      windowMin: 6000, // 6s após interrupção
      windowMax: 30000, // 30s após interrupção
    },
    polarization: {
      valenceNegative: -0.2,
      valencePositive: 0.2,
      difference: 0.5, // Diferença entre grupos
      minParticipants: 3,
    },
  },
  // Camada 3: Sinais Prosódicos
  prosodic: {
    volume: {
      low: -28, // dBFS
      lowCritical: -34,
      high: -10,
      highCritical: -6,
    },
    arousal: {
      low: -0.4,
      lowInfo: -0.2,
      high: 0.5,
      highWarning: 0.7,
    },
    valence: {
      negativeSevere: -0.6,
      negativeInfo: -0.35,
    },
    monotony: {
      stdevWarning: 0.06,
      stdevInfo: 0.1,
    },
    rhythm: {
      accelerated: {
        switchesPerSec: 1.0,
        minSegments: 6,
        warningThreshold: 1.5,
      },
      paused: {
        longestSilence: 5.0, // segundos
        warningThreshold: 7.0,
        minCoverage: 0.10,
      },
    },
    groupEnergy: {
      low: -0.3,
      lowWarning: -0.5,
    },
  },
  // Camada 4: Estados de Longo Prazo
  longTerm: {
    silence: {
      windowMs: 60000, // 60s
      speechCoverage: 0.05, // < 5%
      rmsThreshold: -50, // dBFS
      minSamples: 10,
    },
    overlap: {
      minParticipants: 2,
      minCoverage: 0.2,
    },
    interruptions: {
      windowMs: 60000, // 60s
      minCount: 5,
      throttleMs: 2000,
    },
    monologue: {
      windowMs: 60000, // 60s
      dominanceRatio: 0.8, // ≥80%
      minSpeechEvents: 10,
    },
  },
  // Cooldowns (em ms)
  cooldowns: {
    primaryEmotion: {
      hostility: 30000,
      boredom: 25000,
      frustration: 25000,
      confusion: 20000,
      positiveEngagement: 60000, // Mais longo para evitar spam de elogios
    },
    meta: {
      frustrationTrend: 25000,
      postInterruption: 25000,
      polarization: 45000,
    },
    prosodic: {
      volume: 10000,
      monotony: 20000,
      rhythmAccelerated: 20000,
      rhythmPaused: 60000,
      arousal: 15000,
      valence: 20000,
      groupEnergy: 30000,
    },
    longTerm: {
      silence: 30000,
      overlap: 15000,
      interruptions: 30000,
    },
  },
  // Janelas temporais (em ms)
  windows: {
    short: 3000, // 3s
    long: 10000, // 10s
    trend: 20000, // 20s
    prune: 65000, // 65s
  },
  // EMA
  ema: {
    alpha: 0.3,
  },
  // Speech coverage gates
  speechGates: {
    volume: 0.5,
    prosodic: 0.3,
    prosodicStrict: 0.4,
    prosodicVeryStrict: 0.5,
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
  private readonly trendWindowMs = THRESHOLDS.windows.trend;
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
  // HEURÍSTICAS ANTIGAS - SUBSTITUÍDAS PELA PIPELINE A2E2
  // ===================================================================
  // As funções abaixo foram substituídas pela pipeline modular A2E2.
  // Mantidas para referência e possíveis comparações, mas não são mais chamadas.
  // A nova pipeline está em: ./a2e2/pipeline/run-a2e2-pipeline.ts

  // ===================================================================
  // CAMADA 1: EMOÇÕES PRIMÁRIAS (Alta Confiança) - DEPRECATED
  // ===================================================================
  /**
   * @deprecated Substituído pela pipeline A2E2 em ./a2e2/primary/
   * Detecta emoções primárias diretamente fornecidas pela Hume API.
   * Esta é a camada de maior prioridade - sempre tem precedência sobre outras.
   * //Remover
   */
  private detectPrimaryEmotions(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
  ): FeedbackEventPayload | null {
    const w = this.window(state, now, this.longWindowMs);
    if (w.samplesCount < 5) return null;
    if (state.ema.emotions.size === 0) return null; // Requer emoções no EMA

    // 1.1 Hostilidade (anger, disgust, distress)
    const hostilityResult = this.detectHostility(meetingId, participantId, state, now, w);
    if (hostilityResult) return hostilityResult;

    // 1.2 Frustração (frustration direto)
    const frustrationResult = this.detectFrustration(meetingId, participantId, state, now, w);
    if (frustrationResult) return frustrationResult;

    // 1.3 Tédio (boredom, tiredness + interest baixo)
    const boredomResult = this.detectBoredom(meetingId, participantId, state, now, w);
    if (boredomResult) return boredomResult;

    // 1.4 Confusão (confusion, doubt)
    const confusionResult = this.detectConfusion(meetingId, participantId, state, now, w);
    if (confusionResult) return confusionResult;

    // 1.5 Engajamento Positivo (interest, joy, determination)
    const positiveResult = this.detectPositiveEngagement(meetingId, participantId, state, now, w);
    if (positiveResult) return positiveResult;

    return null;
  }

  //Remover
  private detectHostility(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
    w: ReturnType<typeof this.window>,
  ): FeedbackEventPayload | null {
    const anger = state.ema.emotions.get('anger') ?? 0;
    const disgust = state.ema.emotions.get('disgust') ?? 0;
    const distress = state.ema.emotions.get('distress') ?? 0;
    const hostilityScore = Math.max(anger, disgust, distress);

    if (hostilityScore > 0.03) {
      this.logger.log(`[Hostility] ${participantId}: score=${hostilityScore.toFixed(3)} (anger=${anger.toFixed(3)}, disgust=${disgust.toFixed(3)}, distress=${distress.toFixed(3)}) threshold=${THRESHOLDS.primaryEmotion.hostility.anger}`);
    }

    if (hostilityScore > THRESHOLDS.primaryEmotion.hostility.anger) {
      const type = 'hostilidade';
      if (this.inCooldown(state, type, now) || this.inGlobalCooldown(state, now)) return null;
      this.setCooldown(state, type, now, THRESHOLDS.cooldowns.primaryEmotion.hostility);
      
      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      this.logger.log(`[Hostility] 🔥 TRIGGERED for ${participantId}: score=${hostilityScore.toFixed(3)}`);
      return {
        id: this.makeId(),
        type,
        severity: 'warning',
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: `${name}: a conversa esquentou. Considere validar o ponto do outro antes de prosseguir.`,
        tips: ['Respire fundo', 'Use frases como "Entendo seu ponto..."', 'Evite interrupções agora'],
        metadata: {
          valenceEMA: state.ema.valence,
        },
      };
    }
    return null;
  }

  //Remover
  private detectFrustration(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
    w: ReturnType<typeof this.window>,
  ): FeedbackEventPayload | null {
    const frustration = state.ema.emotions.get('frustration') ?? 0;
    
    if (frustration > 0.03) {
      this.logger.log(`[Frustration] ${participantId}: score=${frustration.toFixed(3)} threshold=${THRESHOLDS.primaryEmotion.main}`);
    }
    
    if (frustration > THRESHOLDS.primaryEmotion.main) {
      const type = 'frustracao_crescente';
      if (this.inCooldown(state, type, now) || this.inGlobalCooldown(state, now)) return null;
      this.setCooldown(state, type, now, THRESHOLDS.cooldowns.primaryEmotion.frustration);

      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      this.logger.log(`[Frustration] 😤 TRIGGERED for ${participantId}: score=${frustration.toFixed(3)}`);
      return {
        id: this.makeId(),
        type,
        severity: 'warning',
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: `${name}: parece haver um bloqueio ou frustração.`,
        tips: ['Reconheça a dificuldade', 'Pergunte: "O que está impedindo nosso progresso?"'],
        metadata: {
          valenceEMA: state.ema.valence,
        },
      };
    }
    return null;
  }

  //Remover
  private detectBoredom(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
    w: ReturnType<typeof this.window>,
  ): FeedbackEventPayload | null {
    const boredom = state.ema.emotions.get('boredom') ?? 0;
    const tiredness = state.ema.emotions.get('tiredness') ?? 0;
    const interest = state.ema.emotions.get('interest') ?? 0;
    
    if (boredom > 0.03 || tiredness > 0.05) {
      this.logger.log(`[Boredom] ${participantId}: boredom=${boredom.toFixed(3)}, tiredness=${tiredness.toFixed(3)}, interest=${interest.toFixed(3)}`);
    }
    
    const t = THRESHOLDS.primaryEmotion.boredom;
    if ((boredom > t.boredom || tiredness > t.tiredness) && interest < t.interestLow) {
      const type = 'tedio';
      if (this.inCooldown(state, type, now) || this.inGlobalCooldown(state, now)) return null;
      this.setCooldown(state, type, now, THRESHOLDS.cooldowns.primaryEmotion.boredom);

      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      this.logger.log(`[Boredom] 😴 TRIGGERED for ${participantId}: boredom=${boredom.toFixed(3)}, tiredness=${tiredness.toFixed(3)}`);
      return {
        id: this.makeId(),
        type,
        severity: 'info',
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: `${name}: energia baixa detectada. Que tal trazer um novo ponto de vista?`,
        tips: ['Mude a entonação', 'Faça uma pergunta aberta ao grupo'],
        metadata: {
          arousalEMA: state.ema.arousal,
        },
      };
    }
    return null;
  }

  //Remover
  private detectConfusion(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
    w: ReturnType<typeof this.window>,
  ): FeedbackEventPayload | null {
    const confusion = state.ema.emotions.get('confusion') ?? 0;
    const doubt = state.ema.emotions.get('doubt') ?? 0;
    const score = Math.max(confusion, doubt);

    if (score > 0.03) {
      this.logger.log(`[Confusion] ${participantId}: score=${score.toFixed(3)} (confusion=${confusion.toFixed(3)}, doubt=${doubt.toFixed(3)}) threshold=${THRESHOLDS.primaryEmotion.confusion.confusion}`);
    }

    if (score > THRESHOLDS.primaryEmotion.confusion.confusion) {
      const type = 'confusao';
      if (this.inCooldown(state, type, now) || this.inGlobalCooldown(state, now)) return null;
      this.setCooldown(state, type, now, THRESHOLDS.cooldowns.primaryEmotion.confusion);

      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      this.logger.log(`[Confusion] 🤔 TRIGGERED for ${participantId}: score=${score.toFixed(3)}`);
      return {
        id: this.makeId(),
        type,
        severity: 'info',
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: `${name}: pontos de dúvida detectados. Seria bom checar o entendimento.`,
        tips: ['Pergunte: "Isso faz sentido?"', 'Ofereça um exemplo prático'],
        metadata: {},
      };
    }
    return null;
  }

  //Remover
  private detectPositiveEngagement(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
    w: ReturnType<typeof this.window>,
  ): FeedbackEventPayload | null {
    const interest = state.ema.emotions.get('interest') ?? 0;
    const joy = state.ema.emotions.get('joy') ?? 0;
    const determination = state.ema.emotions.get('determination') ?? 0;
    const score = Math.max(interest, joy, determination);

    if (score > 0.03) {
      this.logger.log(`[PositiveEngagement] ${participantId}: score=${score.toFixed(3)} (interest=${interest.toFixed(3)}, joy=${joy.toFixed(3)}, determination=${determination.toFixed(3)}) threshold=${THRESHOLDS.primaryEmotion.main}`);
    }

    if (score > THRESHOLDS.primaryEmotion.main) {
      const type = 'entusiasmo_alto';
      if (this.inCooldown(state, type, now) || this.inGlobalCooldown(state, now)) return null;
      this.setCooldown(state, type, now, THRESHOLDS.cooldowns.primaryEmotion.positiveEngagement);

      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      this.logger.log(`[PositiveEngagement] 🎉 TRIGGERED for ${participantId}: score=${score.toFixed(3)}`);
      return {
        id: this.makeId(),
        type,
        severity: 'info',
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: `${name}: ótima energia e clareza! O grupo parece engajado.`,
        tips: ['Mantenha esse tom', 'Aproveite para definir próximos passos'],
        metadata: {},
      };
    }
    return null;
  }

  // ===================================================================
  // CAMADA 2: META-ESTADOS EMOCIONAIS (Combinações)
  // ===================================================================
  /**
   * Detecta estados emocionais complexos através de combinações lógicas
   * entre sinais primários. Só executa se Camada 1 não retornou feedback.
   * //Remover
   */
  private detectMetaStates(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
  ): FeedbackEventPayload | null {
    // 2.1 Frustração Crescente (tendência: arousal↑ + valence↓)
    const frustrationTrendResult = this.detectFrustrationTrend(meetingId, participantId, state, now);
    if (frustrationTrendResult) return frustrationTrendResult;

    // 2.2 Efeito Pós-Interrupção (queda de valence após interrupção)
    const postInterruptionResult = this.detectPostInterruption(meetingId, now);
    if (postInterruptionResult) return postInterruptionResult;

    // 2.3 Polarização Emocional (divisão do grupo)
    const polarizationResult = this.detectPolarization(meetingId, now);
    if (polarizationResult) return polarizationResult;

    return null;
  }

  //Remover
  private detectFrustrationTrend(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
  ): FeedbackEventPayload | null {
    // Só executa se não há emoções primárias (fallback)
    if (state.ema.emotions.size > 0) return null;

    const start = now - this.trendWindowMs;
    let arousalEarlySum = 0;
    let arousalEarlyN = 0;
    let arousalLateSum = 0;
    let arousalLateN = 0;
    let valenceEarlySum = 0;
    let valenceEarlyN = 0;
    let valenceLateSum = 0;
    let valenceLateN = 0;
    let speechN = 0;
    
    for (let i = state.samples.length - 1; i >= 0; i--) {
      const s = state.samples[i];
      if (s.ts < start) break;
      if (s.speech) speechN++;
      const isEarly = s.ts < now - this.trendWindowMs / 2;
      if (isEarly) {
        if (typeof s.arousal === 'number') {
          arousalEarlySum += s.arousal;
          arousalEarlyN++;
        }
        if (typeof s.valence === 'number') {
          valenceEarlySum += s.valence;
          valenceEarlyN++;
        }
      } else {
        if (typeof s.arousal === 'number') {
          arousalLateSum += s.arousal;
          arousalLateN++;
        }
        if (typeof s.valence === 'number') {
          valenceLateSum += s.valence;
          valenceLateN++;
        }
      }
    }
    
    const totalN = arousalEarlyN + arousalLateN + valenceEarlyN + valenceLateN;
    if (speechN < 5 || totalN < 8) return null;
    
    const arousalEarly = arousalEarlyN > 0 ? arousalEarlySum / arousalEarlyN : undefined;
    const arousalLate = arousalLateN > 0 ? arousalLateSum / arousalLateN : undefined;
    const valenceEarly = valenceEarlyN > 0 ? valenceEarlySum / valenceEarlyN : undefined;
    const valenceLate = valenceLateN > 0 ? valenceLateSum / valenceLateN : undefined;
    
    if (typeof arousalEarly !== 'number' || typeof arousalLate !== 'number') return null;
    if (typeof valenceEarly !== 'number' || typeof valenceLate !== 'number') return null;
    
    const arousalDelta = arousalLate - arousalEarly;
    const valenceDelta = valenceLate - valenceEarly;
    const t = THRESHOLDS.meta.frustrationTrend;
    
    if (arousalDelta >= t.arousalDelta && valenceDelta <= t.valenceDelta) {
      const type = 'frustracao_crescente';
      if (this.inCooldown(state, type, now)) return null;
      this.setCooldown(state, type, now, THRESHOLDS.cooldowns.meta.frustrationTrend);
      
      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      return {
        id: this.makeId(),
        type,
        severity: 'warning',
        ts: now,
        meetingId,
        participantId,
        window: { start, end: now },
        message: `${name}: indícios de frustração crescente.`,
        tips: ['Reduza o ritmo e cheque entendimento', 'Valide objeções antes de avançar'],
        metadata: {
          arousalEMA: state.ema.arousal,
          valenceEMA: state.ema.valence,
        },
      };
    }
    return null;
  }

  //Remover
  private detectPostInterruption(meetingId: string, now: number): FeedbackEventPayload | null {
    const list = this.postInterruptionCandidatesByMeeting.get(meetingId);
    if (!list || list.length === 0) return null;
    
    const t = THRESHOLDS.meta.postInterruption;
    const remaining: Array<{ ts: number; interruptedId: string; valenceBefore?: number }> = [];
    
    for (const rec of list) {
      const age = now - rec.ts;
      if (age < t.windowMin) {
        remaining.push(rec);
        continue;
      }
      if (age > t.windowMax) {
        continue; // expired
      }
      
      const st = this.byKey.get(this.key(meetingId, rec.interruptedId));
      if (!st || typeof st.ema.valence !== 'number' || typeof rec.valenceBefore !== 'number') {
        remaining.push(rec);
        continue;
      }
      
      const delta = st.ema.valence - rec.valenceBefore;
      const w = this.window(st, now, this.longWindowMs);
      const coverage = w.samplesCount > 0 ? w.speechCount / w.samplesCount : 0;
      
      if (delta <= t.valenceDelta && coverage >= t.minCoverage) {
        const type = 'efeito_pos_interrupcao';
        if (!this.inCooldown(st, type, now)) {
          this.setCooldown(st, type, now, THRESHOLDS.cooldowns.meta.postInterruption);
          const name = this.index.getParticipantName(meetingId, rec.interruptedId) ?? rec.interruptedId;
          return {
            id: this.makeId(),
            type,
            severity: 'warning',
            ts: now,
            meetingId,
            participantId: rec.interruptedId,
            window: { start: rec.ts, end: now },
            message: `${name}: queda de ânimo após interrupção.`,
            tips: ['Convide a concluir a ideia interrompida', 'Garanta espaço de fala'],
            metadata: {
              valenceEMA: st.ema.valence,
            },
          };
        }
      } else {
        remaining.push(rec);
      }
    }
    
    this.postInterruptionCandidatesByMeeting.set(meetingId, remaining);
    return null;
  }

  //Remover
  private detectPolarization(meetingId: string, now: number): FeedbackEventPayload | null {
    const participants = this.participantsForMeeting(meetingId);
    const t = THRESHOLDS.meta.polarization;
    if (participants.length < t.minParticipants) return null;
    
    const negVals: number[] = [];
    const posVals: number[] = [];
    
    for (const [pid, st] of participants) {
      if (this.index.getParticipantRole(meetingId, pid) === 'host') continue;
      const w = this.window(st, now, this.longWindowMs);
      if (w.samplesCount === 0) continue;
      const coverage = w.speechCount / w.samplesCount;
      if (coverage < THRESHOLDS.speechGates.prosodic) continue;
      
      const v = st.ema.valence;
      if (typeof v !== 'number') continue;
      if (v <= t.valenceNegative) negVals.push(v);
      if (v >= t.valencePositive) posVals.push(v);
    }
    
    if (negVals.length === 0 || posVals.length === 0) return null;
    
    const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const negMean = mean(negVals);
    const posMean = mean(posVals);
    
    if (posMean - negMean >= t.difference) {
      const type = 'polarizacao_emocional';
      if (this.inCooldownMeeting(meetingId, type, now)) return null;
      this.setCooldownMeeting(meetingId, type, now, THRESHOLDS.cooldowns.meta.polarization);
      
      return {
        id: this.makeId(),
        type,
        severity: 'warning',
        ts: now,
        meetingId,
        participantId: 'group',
        window: { start: now - this.longWindowMs, end: now },
        message: `Polarização emocional no grupo (opiniões muito divergentes).`,
        tips: ['Reconheça pontos de ambos os lados', 'Estabeleça objetivos comuns antes de decidir'],
        metadata: {
          valenceEMA: Number(((posMean + negMean) / 2).toFixed(3)),
        },
      };
    }
    return null;
  }

  // ===================================================================
  // CAMADA 3: SINAIS PROSÓDICOS (Arousal, Valence, Energia)
  // ===================================================================
  /**
   * Detecta sinais prosódicos baseados em métricas acústicas.
   * Só executa se Camadas 1 e 2 não retornaram feedback.
   * NÃO duplica emoções primárias (ex: excitement vs arousal alto).
   * //Remover
   */
  private detectProsodicSignals(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
  ): FeedbackEventPayload | null {
    // 3.1 Volume (RMS)
    const volumeResult = this.detectVolume(meetingId, participantId, state, now);
    if (volumeResult) return volumeResult;

    // 3.2 Monotonia Prosódica (variância de arousal)
    const monotonyResult = this.detectMonotony(meetingId, participantId, state, now);
    if (monotonyResult) return monotonyResult;

    // 3.3 Ritmo (acelerado/pausado)
    const rhythmResult = this.detectRhythm(meetingId, participantId, state, now);
    if (rhythmResult) return rhythmResult;

    // 3.4 Arousal (alto/baixo) - só se não há emoções primárias
    if (state.ema.emotions.size === 0) {
      const arousalResult = this.detectArousal(meetingId, participantId, state, now);
      if (arousalResult) return arousalResult;
    }

    // 3.5 Valence (negativo) - só se não há emoções primárias
    if (state.ema.emotions.size === 0) {
      const valenceResult = this.detectValence(meetingId, participantId, state, now);
      if (valenceResult) return valenceResult;
    }

    // 3.6 Energia do Grupo (arousal médio)
    const groupEnergyResult = this.detectGroupEnergy(meetingId, now);
    if (groupEnergyResult) return groupEnergyResult;

    return null;
  }

  //Remover
  private detectVolume(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
  ): FeedbackEventPayload | null {
    const w = this.window(state, now, this.shortWindowMs);
    if (w.samplesCount < 1) return null;
    const speechCoverage = w.speechCount / w.samplesCount;
    if (speechCoverage < THRESHOLDS.speechGates.volume) return null;
    
    const mean = w.meanRmsDbfs;
    const ema = state.ema.rms;
    const level = typeof mean === 'number' ? mean : typeof ema === 'number' ? ema : undefined;
    if (typeof level !== 'number') return null;

    const t = THRESHOLDS.prosodic.volume;
    const isLow = level <= t.low;
    const isHigh = level >= t.high;

    if (isLow && isHigh) return null; // Conflito impossível

    if (isLow) {
      const type = 'volume_baixo';
      if (this.inCooldown(state, type, now) || this.inGlobalCooldown(state, now)) return null;
      const severity = level <= t.lowCritical ? 'critical' : 'warning';
      this.setCooldown(state, type, now, THRESHOLDS.cooldowns.prosodic.volume);
      
      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      return {
        id: this.makeId(),
        type,
        severity,
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: severity === 'critical'
          ? `${name}: quase inaudível; aumente o ganho imediatamente.`
          : `${name}: volume baixo; aproxime-se do microfone.`,
        tips: severity === 'critical'
          ? ['Aumente o ganho de entrada', 'Aproxime-se do microfone']
          : ['Verifique entrada de áudio', 'Desative redução agressiva de ruído'],
        metadata: {
          rmsDbfs: level,
          speechCoverage,
        },
      };
    }

    if (isHigh) {
      const type = 'volume_alto';
      if (this.inCooldown(state, type, now) || this.inGlobalCooldown(state, now)) return null;
      const severity = level >= t.highCritical ? 'critical' : 'warning';
      this.setCooldown(state, type, now, THRESHOLDS.cooldowns.prosodic.volume);
      
      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      return {
        id: this.makeId(),
        type,
        severity,
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: severity === 'critical'
          ? `${name}: áudio clipando; reduza o ganho.`
          : `${name}: volume alto; afaste-se um pouco.`,
        tips: ['Reduza sensibilidade do microfone'],
        metadata: {
          rmsDbfs: level,
          speechCoverage,
        },
      };
    }

    return null;
  }

  //Remover
  private detectMonotony(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
  ): FeedbackEventPayload | null {
    const start = now - this.longWindowMs;
    const values: number[] = [];
    let speechN = 0;
    
    for (let i = state.samples.length - 1; i >= 0; i--) {
      const s = state.samples[i];
      if (s.ts < start) break;
      if (s.speech) speechN++;
      if (typeof s.arousal === 'number') values.push(s.arousal);
    }
    
    if (speechN < 5 || values.length < 5) return null;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
    const stdev = Math.sqrt(variance);
    
    const t = THRESHOLDS.prosodic.monotony;
    if (stdev < t.stdevInfo) {
      const type = 'monotonia_prosodica';
      if (this.inCooldown(state, type, now)) return null;
      const severity: 'info' | 'warning' = stdev < t.stdevWarning ? 'warning' : 'info';
      this.setCooldown(state, type, now, THRESHOLDS.cooldowns.prosodic.monotony);
      
      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      return {
        id: this.makeId(),
        type,
        severity,
        ts: now,
        meetingId,
        participantId,
        window: { start, end: now },
        message: severity === 'warning'
          ? `${name}: fala monótona; varie entonação e pausas.`
          : `${name}: pouca variação de entonação.`,
        tips: ['Use pausas e ênfases para destacar pontos'],
        metadata: {
          arousalEMA: state.ema.arousal,
        },
      };
    }
    return null;
  }

  //Remover
  private detectRhythm(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
  ): FeedbackEventPayload | null {
    const start = now - this.longWindowMs;
    const samples = state.samples.filter((s) => s.ts >= start);
    if (samples.length < 6) return null;
    
    let switches = 0;
    let speechSegments = 0;
    let longestSilence = 0;
    let currentIsSpeech: boolean | undefined = undefined;
    let currentStart = start;
    let lastTs = start;
    
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const segDur = (s.ts - lastTs) / 1000;
      if (typeof currentIsSpeech === 'boolean' && !currentIsSpeech) {
        if (segDur > longestSilence) longestSilence = segDur;
      }
      if (typeof currentIsSpeech !== 'boolean') {
        currentIsSpeech = s.speech;
        currentStart = s.ts;
        lastTs = s.ts;
        continue;
      }
      if (s.speech !== currentIsSpeech) {
        switches++;
        const dur = (s.ts - currentStart) / 1000;
        if (currentIsSpeech) {
          speechSegments++;
        } else {
          if (dur > longestSilence) longestSilence = dur;
        }
        currentIsSpeech = s.speech;
        currentStart = s.ts;
      }
      lastTs = s.ts;
    }
    
    const tailDur = (now - currentStart) / 1000;
    if (currentIsSpeech) {
      speechSegments++;
    } else {
      if (tailDur > longestSilence) longestSilence = tailDur;
    }
    
    const windowSec = this.longWindowMs / 1000;
    const switchesPerSec = switches / windowSec;
    const w = this.window(state, now, this.longWindowMs);
    const speechCoverage = w.samplesCount > 0 ? w.speechCount / w.samplesCount : 0;

    const hasSpokenBefore = state.samples.some(s => s.speech);
    if (!hasSpokenBefore) return null;

    const tAccel = THRESHOLDS.prosodic.rhythm.accelerated;
    const tPaused = THRESHOLDS.prosodic.rhythm.paused;
    const isAccelerated = switchesPerSec >= tAccel.switchesPerSec && speechSegments >= tAccel.minSegments;
    const isPaused = longestSilence >= tPaused.longestSilence && speechCoverage < tPaused.minCoverage;

    if (isAccelerated && isPaused) return null; // Conflito: ignorar ambos

    if (isAccelerated) {
      const type = 'ritmo_acelerado';
      if (this.inCooldown(state, type, now) || this.inGlobalCooldown(state, now)) return null;
      this.setCooldown(state, type, now, THRESHOLDS.cooldowns.prosodic.rhythmAccelerated);
      const severity: 'info' | 'warning' = switchesPerSec >= tAccel.warningThreshold ? 'warning' : 'info';
      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      return {
        id: this.makeId(),
        type,
        severity,
        ts: now,
        meetingId,
        participantId,
        window: { start, end: now },
        message: severity === 'warning'
          ? `${name}: ritmo acelerado; desacelere para melhor entendimento.`
          : `${name}: ritmo rápido; considere pausas curtas.`,
        tips: ['Faça pausas para respiração', 'Enuncie com clareza'],
        metadata: {
          speechCoverage,
        },
      };
    }

    if (isPaused) {
      const type = 'ritmo_pausado';
      if (this.inCooldown(state, type, now) || this.inGlobalCooldown(state, now)) return null;
      this.setCooldown(state, type, now, THRESHOLDS.cooldowns.prosodic.rhythmPaused);
      const severity: 'info' | 'warning' = longestSilence >= tPaused.warningThreshold ? 'warning' : 'info';
      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      return {
        id: this.makeId(),
        type,
        severity,
        ts: now,
        meetingId,
        participantId,
        window: { start, end: now },
        message: severity === 'warning'
          ? `${name}: pausas muito longas (≥7s); tente manter um ritmo mais constante.`
          : `${name}: ritmo lento; considere reduzir pausas longas.`,
        tips: ['Reduza pausas longas', 'Mantenha frases mais curtas'],
        metadata: {
          speechCoverage,
        },
      };
    }

    return null;
  }

  //Remover
  private detectArousal(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
  ): FeedbackEventPayload | null {
    const ar = state.ema.arousal;
    if (typeof ar !== 'number') return null;
    const w = this.window(state, now, this.longWindowMs);
    if (w.samplesCount < 5) return null;
    const speechCoverage = w.speechCount / w.samplesCount;
    if (speechCoverage < THRESHOLDS.speechGates.prosodicVeryStrict) return null;
    
    const t = THRESHOLDS.prosodic.arousal;
    if (ar >= t.high) {
      const type = 'entusiasmo_alto';
      if (this.inCooldown(state, type, now)) return null;
      const severity: 'info' | 'warning' = ar >= t.highWarning ? 'warning' : 'info';
      this.setCooldown(state, type, now, severity === 'warning' ? 20000 : THRESHOLDS.cooldowns.prosodic.arousal);
      
      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      return {
        id: this.makeId(),
        type,
        severity,
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: severity === 'warning'
          ? `${name}: energia muito alta; canalize em próximos passos.`
          : `${name}: entusiasmo alto; ótimo momento para direcionar ações.`,
        tips: ['Direcione para decisões e próximos passos'],
        metadata: {
          arousalEMA: ar,
          speechCoverage,
        },
      };
    }
    
    if (ar <= t.low || ar <= t.lowInfo) {
      const type = 'engajamento_baixo';
      if (this.inCooldown(state, type, now)) return null;
      const warn = ar <= t.low;
      this.setCooldown(state, type, now, warn ? 20000 : THRESHOLDS.cooldowns.prosodic.arousal);
      
      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      return {
        id: this.makeId(),
        type,
        severity: warn ? 'warning' : 'info',
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: warn
          ? `${name}: engajamento baixo (tom desanimado).`
          : `${name}: energia baixa. Um pouco mais de ênfase pode ajudar.`,
        tips: ['Fale com mais variação de tom', 'Projete a voz mais próxima do microfone'],
        metadata: {
          arousalEMA: ar,
          speechCoverage,
        },
      };
    }
    
    return null;
  }

  //Remover
  private detectValence(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
  ): FeedbackEventPayload | null {
    const val = state.ema.valence;
    if (typeof val !== 'number') return null;
    const w = this.window(state, now, this.longWindowMs);
    if (w.samplesCount < 5) return null;
    const speechCoverage = w.speechCount / w.samplesCount;
    if (speechCoverage < THRESHOLDS.speechGates.prosodicStrict) return null;
    
    const t = THRESHOLDS.prosodic.valence;
    // CORRIGIDO: Removida condição redundante
    if (val <= t.negativeSevere) {
      const type = 'tendencia_emocional_negativa';
      if (this.inCooldown(state, type, now)) return null;
      this.setCooldown(state, type, now, 25000);
      
      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      return {
        id: this.makeId(),
        type,
        severity: 'warning',
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: `${name}: tom negativo perceptível. Considere suavizar a comunicação.`,
        tips: ['Mostre concordância antes de divergir', 'Evite frases muito secas'],
        metadata: {
          valenceEMA: val,
          speechCoverage,
        },
      };
    } else if (val <= t.negativeInfo) {
      const type = 'tendencia_emocional_negativa';
      if (this.inCooldown(state, type, now)) return null;
      this.setCooldown(state, type, now, 20000);
      
      const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
      return {
        id: this.makeId(),
        type,
        severity: 'info',
        ts: now,
        meetingId,
        participantId,
        window: { start: w.start, end: w.end },
        message: `${name}: tendência emocional negativa. Tente um tom mais positivo.`,
        tips: ['Mostre concordância antes de divergir', 'Evite frases muito secas'],
        metadata: {
          valenceEMA: val,
          speechCoverage,
        },
      };
    }
    
    return null;
  }

  //Remover
  private detectGroupEnergy(meetingId: string, now: number): FeedbackEventPayload | null {
    const participants = this.participantsForMeeting(meetingId);
    if (participants.length === 0) return null;
    
    let sum = 0;
    let n = 0;
    for (const [pid, st] of participants) {
      const role = this.index.getParticipantRole(meetingId, pid);
      if (role === 'host') continue;
      const w = this.window(st, now, this.longWindowMs);
      if (w.samplesCount === 0) continue;
      const coverage = w.speechCount / w.samplesCount;
      if (coverage < THRESHOLDS.speechGates.prosodic) continue;
      if (typeof st.ema.arousal === 'number') {
        sum += st.ema.arousal;
        n++;
      }
    }
    
    if (n === 0) return null;
    const mean = sum / n;
    const t = THRESHOLDS.prosodic.groupEnergy;
    
    if (mean <= t.low) {
      const type = 'energia_grupo_baixa';
      if (this.inCooldownMeeting(meetingId, type, now)) return null;
      const severity: 'info' | 'warning' = mean <= t.lowWarning ? 'warning' : 'info';
      this.setCooldownMeeting(meetingId, type, now, THRESHOLDS.cooldowns.prosodic.groupEnergy);
      
      return {
        id: this.makeId(),
        type,
        severity,
        ts: now,
        meetingId,
        participantId: 'group',
        window: { start: now - this.longWindowMs, end: now },
        message: severity === 'warning'
          ? `Energia do grupo baixa. Considere perguntas diretas ou mudança de dinâmica.`
          : `Energia do grupo em queda. Estimule participação.`,
        tips: ['Convide pessoas específicas a opinar', 'Introduza uma pergunta aberta'],
        metadata: {
          arousalEMA: mean,
        },
      };
    }
    return null;
  }

  // ===================================================================
  // CAMADA 4: ESTADOS DE LONGO PRAZO (Comportamentais)
  // ===================================================================
  /**
   * Detecta padrões comportamentais de longo prazo.
   * Menor prioridade - só executa se camadas 1-3 não retornaram feedback.
   * //Remover
   */
  private detectLongTermSignals(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
  ): FeedbackEventPayload | null {
    // 4.1 Silêncio Prolongado
    const silenceResult = this.detectSilence(meetingId, participantId, state, now);
    if (silenceResult) return silenceResult;

    // 4.2 Overlap de Fala
    const overlapResult = this.detectOverlap(meetingId, participantId, now);
    if (overlapResult) return overlapResult;

    // 4.3 Interrupções Frequentes
    const interruptionsResult = this.detectInterruptions(meetingId, participantId, now);
    if (interruptionsResult) return interruptionsResult;

    return null;
  }

  //Remover
  private detectSilence(
    meetingId: string,
    participantId: string,
    state: ParticipantState,
    now: number,
  ): FeedbackEventPayload | null {
    const t = THRESHOLDS.longTerm.silence;
    const window = this.window(state, now, t.windowMs);
    if (window.samplesCount < t.minSamples) return null;
    
    const speechCoverage = window.speechCount / window.samplesCount;
    if (speechCoverage >= t.speechCoverage) return null;
    
    const hasSpokenBefore = state.samples.some(s => s.speech);
    if (!hasSpokenBefore) return null;
    
    const rms = window.meanRmsDbfs;
    const isMicPossiblyMuted = typeof rms !== 'number' || rms <= t.rmsThreshold;
    if (!isMicPossiblyMuted) return null;
    
    const type = 'silencio_prolongado';
    if (this.inCooldown(state, type, now) || this.inGlobalCooldown(state, now)) return null;
    this.setCooldown(state, type, now, THRESHOLDS.cooldowns.longTerm.silence);
    
    const name = this.index.getParticipantName(meetingId, participantId) ?? participantId;
    return {
      id: this.makeId(),
      type,
      severity: 'warning',
      ts: now,
      meetingId,
      participantId,
      window: { start: window.start, end: window.end },
      message: `${name}: sem áudio há 60s; microfone pode estar desconectado.`,
      tips: ['Verifique se o microfone está conectado', 'Cheque as permissões de áudio'],
      metadata: {
        speechCoverage,
        rmsDbfs: rms,
      },
    };
  }

  //Remover
  private detectOverlap(meetingId: string, participantId: string, now: number): FeedbackEventPayload | null {
    const participants = this.participantsForMeeting(meetingId);
    const t = THRESHOLDS.longTerm.overlap;
    if (participants.length < t.minParticipants) return null;
    
    const speaking: Array<{ id: string; coverage: number; state: ParticipantState }> = [];
    for (const [pid, st] of participants) {
      const w = this.window(st, now, this.longWindowMs);
      if (w.samplesCount === 0) continue;
      const coverage = w.speechCount / w.samplesCount;
      if (coverage >= t.minCoverage) {
        speaking.push({ id: pid, coverage, state: st });
      }
    }
    
    if (speaking.length >= t.minParticipants) {
      const target = speaking.find((s) => s.id === participantId) ?? speaking.sort((a, b) => b.coverage - a.coverage)[0];
      const type = 'overlap_fala';
      if (this.inCooldown(target.state, type, now)) return null;
      this.setCooldown(target.state, type, now, THRESHOLDS.cooldowns.longTerm.overlap);
      
      const name = this.index.getParticipantName(meetingId, target.id) ?? target.id;
      return {
        id: this.makeId(),
        type,
        severity: 'warning',
        ts: now,
        meetingId,
        participantId: target.id,
        window: { start: now - this.longWindowMs, end: now },
        message: `${name} e outra pessoa falando ao mesmo tempo com frequência.`,
        tips: ['Combine turnos de fala', 'Use levantar a mão'],
        metadata: {
          speechCoverage: speaking.find((s) => s.id === target.id)?.coverage,
        },
      };
    }
    return null;
  }

  //Remover
  private detectInterruptions(meetingId: string, participantId: string, now: number): FeedbackEventPayload | null {
    const participants = this.participantsForMeeting(meetingId);
    if (participants.length < 2) return null;
    
    const t = THRESHOLDS.longTerm.interruptions;
    let speakingCount = 0;
    const covers: Array<{ id: string; coverage: number }> = [];
    
    for (const [pid, st] of participants) {
      const w = this.window(st, now, this.shortWindowMs);
      if (w.samplesCount === 0) continue;
      const coverage = w.speechCount / w.samplesCount;
      covers.push({ id: pid, coverage });
      if (coverage >= 0.2) speakingCount++;
    }
    
    const keyThrottle = meetingId;
    if (speakingCount >= 2) {
      const lastAt = this.lastOverlapSampleAtByMeeting.get(keyThrottle) ?? 0;
      if (now - lastAt >= t.throttleMs) {
        this.lastOverlapSampleAtByMeeting.set(keyThrottle, now);
        const arr = this.overlapHistoryByMeeting.get(meetingId) ?? [];
        arr.push(now);
        const cutoff = now - t.windowMs;
        while (arr.length > 0 && arr[0] < cutoff) arr.shift();
        this.overlapHistoryByMeeting.set(meetingId, arr);
        
        // Capturar candidato a pós-interrupção
        const lastSpeaker = this.lastSpeakerByMeeting.get(meetingId);
        if (lastSpeaker) {
          const someoneElseSpeaking = covers.some((c) => c.id !== lastSpeaker && c.coverage >= 0.2);
          if (someoneElseSpeaking) {
            const st = this.byKey.get(this.key(meetingId, lastSpeaker));
            const before = st?.ema.valence;
            const list = this.postInterruptionCandidatesByMeeting.get(meetingId) ?? [];
            list.push({ ts: now, interruptedId: lastSpeaker, valenceBefore: before });
            while (list.length > 10) list.shift();
            this.postInterruptionCandidatesByMeeting.set(meetingId, list);
          }
        }
      }
    }
    
    const arr = this.overlapHistoryByMeeting.get(meetingId) ?? [];
    if (arr.length >= t.minCount) {
      const type = 'interrupcoes_frequentes';
      if (this.inCooldownMeeting(meetingId, type, now)) return null;
      this.setCooldownMeeting(meetingId, type, now, THRESHOLDS.cooldowns.longTerm.interruptions);
      
      const longCovers = covers
        .map((c) => {
          const st = participants.find(([pid]) => pid === c.id)?.[1];
          if (!st) return { id: c.id, coverage: 0 };
          const w = this.window(st, now, this.longWindowMs);
          const cov = w.samplesCount > 0 ? w.speechCount / w.samplesCount : 0;
          return { id: c.id, coverage: cov };
        })
        .sort((a, b) => b.coverage - a.coverage)
        .slice(0, 2);
      const names = longCovers
        .map((x) => this.index.getParticipantName(meetingId, x.id) ?? x.id)
        .filter(Boolean);
      const who = names.length > 0 ? ` (${names.join(' , ')})` : '';
      
      return {
        id: this.makeId(),
        type,
        severity: 'warning',
        ts: now,
        meetingId,
        participantId: 'group',
        window: { start: now - t.windowMs, end: now },
        message: `Interrupções frequentes nos últimos 60s${who}. Combine turnos de fala.`,
        tips: ['Use levantar a mão', 'Defina ordem de fala'],
        metadata: {},
      };
    }
    return null;
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

  // ========================================================================
  // FASE 2: EXTRAÇÃO DE FRASES REPRESENTATIVAS
  // ========================================================================
  /**
   * Extrai frases representativas de indecisão do histórico de textos.
   * 
   * Filtra textos que:
   * - Têm categoria de indecisão (stalling, objection_soft)
   * - Têm confiança mínima (>= minConfidence)
   * - Estão dentro da janela temporal especificada
   * 
   * Retorna até maxPhrases frases, ordenadas por confiança (maior primeiro).
   * 
   * @param state Estado do participante contendo histórico de textos
   * @param now Timestamp atual em milissegundos
   * @param windowMs Janela temporal em milissegundos (padrão: 60000 = 60s)
   * @param maxPhrases Número máximo de frases a retornar (padrão: 5)
   * @param minConfidence Confiança mínima necessária (padrão: 0.6)
   * @returns Array de strings com frases representativas, ordenadas por confiança
   * 
   * @example
   * ```typescript
   * const phrases = this.extractRepresentativePhrases(state, now, 60000, 5, 0.6);
   * // Retorna até 5 frases de indecisão dos últimos 60 segundos
   * ```
   *
   * @deprecated LEGACY — replaced by DetectClientIndecision.extractRepresentativePhrases()
   * in a2e2/text-analysis/detect-client-indecision.ts. Not called anywhere. Safe to remove.
   */
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

  // ========================================================================
  // FASE 3: DETECÇÃO DE PADRÕES SEMÂNTICOS
  // ========================================================================
  /**
   * Detecta padrões semânticos de indecisão baseado em análise contextual.
   * 
   * Analisa o estado atual do participante e identifica três padrões específicos:
   * 1. decision_postponement: Cliente consistentemente posterga decisões
   * 2. conditional_language: Cliente usa linguagem condicional/aberta
   * 3. lack_of_commitment: Cliente evita compromissos claros
   * 
   * @param state Estado do participante contendo análise de texto
   * @returns Objeto com três flags booleanas indicando quais padrões foram detectados
   * 
   * @example
   * ```typescript
   * const patterns = this.detectIndecisionPatterns(state);
   * if (patterns.decision_postponement) {
   *   // Cliente está postergando decisões
   * }
   * ```
   *
   * @deprecated LEGACY — replaced by DetectClientIndecision.detectIndecisionPatterns()
   * in a2e2/text-analysis/detect-client-indecision.ts. Not called anywhere. Safe to remove.
   */
  private detectIndecisionPatterns(
    state: ParticipantState
  ): {
    decision_postponement: boolean;
    conditional_language: boolean;
    lack_of_commitment: boolean;
  } {
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      return {
        decision_postponement: false,
        conditional_language: false,
        lack_of_commitment: false,
      };
    }
    
    const aggregated = textAnalysis.sales_category_aggregated;
    const trend = textAnalysis.sales_category_trend;
    const ambiguity = textAnalysis.sales_category_ambiguity ?? 0;
    const keywords = textAnalysis.keywords ?? [];
    const flags = textAnalysis.sales_category_flags;
    const conditionalKeywordsDetected = textAnalysis.conditional_keywords_detected ?? [];
    const indecisionMetrics = textAnalysis.indecision_metrics;
    const indecisionScore = indecisionMetrics?.indecision_score ?? 0;
    const postponementLikelihood = indecisionMetrics?.postponement_likelihood ?? 0;
    const conditionalLanguageScore = indecisionMetrics?.conditional_language_score ?? 0;
    
    // ========================================================================
    // Padrão 1: Decision Postponement
    // ========================================================================
    // Cliente consistentemente posterga decisões
    // 
    // Verifica:
    // 1. Flag do Python (decision_postponement_signal) OU
    // 2. Análise contextual (stalling + stable + low velocity)
    const pythonDecisionPostponementFlag = flags?.decision_postponement_signal ?? false;
    const isStallingDominant = aggregated?.dominant_category === 'stalling';
    const isStable = trend?.trend === 'stable';
    const isLowVelocity = (trend?.velocity ?? 1) < 0.1;
    const contextualDecisionPostponement = isStallingDominant && isStable && isLowVelocity;
    // 3. Métrica do Python (postponement_likelihood) acima de threshold
    const metricsDecisionPostponement = postponementLikelihood >= 0.6;
    const decision_postponement =
      pythonDecisionPostponementFlag || contextualDecisionPostponement || metricsDecisionPostponement;
    
    // ========================================================================
    // Padrão 2: Conditional Language
    // ========================================================================
    // Cliente usa linguagem condicional/aberta
    // 
    // Verifica:
    // 1. Flag do Python (conditional_language_signal) OU
    // 2. Alta ambiguidade + conditional keywords detectadas pelo Python OU
    // 3. Alta ambiguidade + conditional keywords nas keywords gerais
    const pythonConditionalLanguageFlag = flags?.conditional_language_signal ?? false;
    const hasConditionalKeywordsFromPython = conditionalKeywordsDetected.length > 0;
    const conditionalKeywords = [
      'talvez',
      'pensar',
      'avaliar',
      'depois',
      'ver',
      'consultar',
      'depende',
      'preciso',
      'vou ver',
      'deixa',
      'analisar',
      'considerar',
      'refletir',
      'avaliar melhor',
      'pensar melhor',
    ];
    const hasConditionalKeywordsInGeneral = keywords.some(kw => 
      conditionalKeywords.some(ck => kw.toLowerCase().includes(ck))
    );
    const highAmbiguityWithKeywords = ambiguity > 0.7 && (hasConditionalKeywordsFromPython || hasConditionalKeywordsInGeneral);
    // 4. Métrica do Python (conditional_language_score) acima de threshold (>= 2 keywords ≈ 0.4)
    const metricsConditionalLanguage = conditionalLanguageScore >= 0.4;
    const conditional_language =
      pythonConditionalLanguageFlag || highAmbiguityWithKeywords || metricsConditionalLanguage;
    
    // ========================================================================
    // Padrão 3: Lack of Commitment
    // ========================================================================
    // Cliente evita compromissos claros
    // 
    // Verifica:
    // 1. Flag geral de indecisão do Python OU
    // 2. Análise contextual (baixa estabilidade + alta proporção de indecisão)
    const pythonIndecisionFlag = flags?.indecision_detected ?? false;
    const stability = aggregated?.stability ?? 0;
    const distribution = aggregated?.category_distribution ?? {};
    const indecisionRatio = (distribution.stalling ?? 0) + (distribution.objection_soft ?? 0);
    const contextualLackOfCommitment = stability < 0.5 && indecisionRatio > 0.6;
    // 3. Métrica do Python (indecision_score) acima de threshold
    const metricsLackOfCommitment = indecisionScore >= 0.6;
    const lack_of_commitment =
      pythonIndecisionFlag || contextualLackOfCommitment || metricsLackOfCommitment;
    
    return {
      decision_postponement,
      conditional_language,
      lack_of_commitment,
    };
  }

  // ========================================================================
  // FASE 4: CÁLCULO DE CONSISTÊNCIA TEMPORAL
  // ========================================================================
  /**
   * Calcula consistência temporal do padrão de indecisão.
   * 
   * Verifica se o padrão de indecisão se mantém consistente ao longo de uma
   * janela temporal, analisando múltiplos fatores:
   * - Sinais fortes suficientes na janela (>= 2 com intensidade >= 0.25) OU
   * - Proporção de textos de indecisão na janela (>= 70%)
   * - Estabilidade da categoria dominante (>= 0.5)
   * - Tendência estável (sem progresso ou regressão)
   * 
   * @param state Estado do participante contendo histórico de textos
   * @param now Timestamp atual em milissegundos
   * @param windowMs Janela temporal em milissegundos (padrão: 60000 = 60s)
   * @param allowWeakTrend Permite consistência mesmo sem tendência estável
   * @returns true se o padrão é consistente, false caso contrário
   * 
   * @example
   * ```typescript
   * const isConsistent = this.calculateTemporalConsistency(state, now, 60000, true);
   * if (isConsistent) {
   *   // Padrão se mantém consistente ao longo do tempo
   * }
   * ```
   *
   * @deprecated LEGACY — replaced by DetectClientIndecision.calculateTemporalConsistency()
   * in a2e2/text-analysis/detect-client-indecision.ts. Not called anywhere. Safe to remove.
   */
  private calculateTemporalConsistency(
    state: ParticipantState,
    now: number,
    windowMs: number = 60000, // Últimos 60 segundos
    allowWeakTrend: boolean = false
  ): boolean {
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      return false;
    }
    
    const textHistory = textAnalysis.textHistory ?? [];
    if (textHistory.length === 0) {
      return false;
    }
    
    const cutoffTime = now - windowMs;
    const indecisionCategories = ['stalling', 'objection_soft'];
    
    // ========================================================================
    // Filtrar textos dentro da janela temporal
    // ========================================================================
    const windowTexts = textHistory.filter(entry => entry.timestamp >= cutoffTime);
    if (windowTexts.length === 0) {
      return false;
    }
    
    // ========================================================================
    // Contar textos com categoria de indecisão e intensidade mínima
    // ========================================================================
    const indecisionTexts = windowTexts.filter(entry => {
      // Verificar se tem categoria de indecisão
      if (!entry.sales_category || !indecisionCategories.includes(entry.sales_category)) {
        return false;
      }
      
      // Verificar intensidade mínima (>= 0.25)
      if ((entry.sales_category_intensity ?? 0) < 0.25) {
        return false;
      }
      
      return true;
    });

    // ========================================================================
    // Caminho permissivo: poucos sinais fortes em conversa longa
    // ========================================================================
    const indecisionCount = indecisionTexts.length;
    const avgIntensity = indecisionCount > 0
      ? indecisionTexts.reduce((sum, entry) => sum + (entry.sales_category_intensity ?? 0), 0) / indecisionCount
      : 0;
    if (indecisionCount >= 2 && avgIntensity >= 0.25) {
      return true;
    }
    
    // ========================================================================
    // Verificar proporção mínima (70% dos chunks devem ser de indecisão)
    // ========================================================================
    const indecisionRatio = indecisionTexts.length / windowTexts.length;
    if (indecisionRatio < 0.7) {
      return false;
    }
    
    // ========================================================================
    // Verificar estabilidade da categoria dominante (>= 0.5)
    // ========================================================================
    // Estabilidade baixa indica alternância entre categorias, o que não é
    // consistente com um padrão de indecisão mantido ao longo do tempo
    const aggregated = textAnalysis.sales_category_aggregated;
    const stability = aggregated?.stability ?? 0;
    if (stability < 0.5) {
      return false;
    }
    
    // ========================================================================
    // Verificar tendência estável (sem progresso ou regressão)
    // ========================================================================
    // Tendência estável indica que o padrão se mantém ao longo do tempo,
    // sem mudanças significativas na direção da conversa
    const trend = textAnalysis.sales_category_trend;
    const isStable = trend?.trend === 'stable';
    
    if (isStable) {
      return true;
    }

    // Se há sinal forte recente, não exigir tendência estável.
    return allowWeakTrend;
  }

  private hasRecentStrongIndecisionSignal(
    state: ParticipantState,
    now: number,
    windowMs: number = 30000,
    minIntensity: number = 0.30,
  ): boolean {
    const textHistory = state.textAnalysis?.textHistory ?? [];
    if (textHistory.length === 0) {
      return false;
    }

    const cutoffTime = now - windowMs;
    const indecisionCategories = ['stalling', 'objection_soft'];

    return textHistory.some(entry => {
      if (entry.timestamp < cutoffTime) {
        return false;
      }
      if (!entry.sales_category || !indecisionCategories.includes(entry.sales_category)) {
        return false;
      }
      return (entry.sales_category_intensity ?? 0) >= minIntensity;
    });
  }

  // ========================================================================
  // FASE 5: CÁLCULO DE CONFIDENCE COMBINADO
  // ========================================================================
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
   *
   * @deprecated LEGACY — replaced by DetectClientIndecision.calculateIndecisionConfidence()
   * in a2e2/text-analysis/detect-client-indecision.ts. Not called anywhere. Safe to remove.
   */
  private calculateIndecisionConfidence(
    state: ParticipantState,
    patterns: {
      decision_postponement: boolean;
      conditional_language: boolean;
      lack_of_commitment: boolean;
    },
    temporalConsistency: boolean
  ): number {
    const textAnalysis = state.textAnalysis;
    if (!textAnalysis) {
      return 0.0;
    }
    
    const aggregated = textAnalysis.sales_category_aggregated;
    const trend = textAnalysis.sales_category_trend;
    
    // ========================================================================
    // Base: número de padrões detectados (0 a 3)
    // ========================================================================
    // Quanto mais padrões detectados, maior a confiança de que há indecisão
    const patternsCount = Object.values(patterns).filter(Boolean).length;
    const patternsScore = patternsCount / 3.0; // Normalizar para 0.0 a 1.0
    
    // ========================================================================
    // Estabilidade da categoria dominante (0.0 a 1.0)
    // ========================================================================
    // Estabilidade alta indica que o padrão é consistente
    const stability = aggregated?.stability ?? 0;
    
    // ========================================================================
    // Força da tendência (0.0 a 1.0)
    // ========================================================================
    // Força alta indica que a tendência estável é bem definida
    const trendStrength = trend?.trend_strength ?? 0;
    
    // ========================================================================
    // Volume de dados (normalizado, 0.0 a 1.0)
    // ========================================================================
    // Mínimo 5 chunks, ideal 10+ chunks
    // Mais dados = maior confiança na análise
    const totalChunks = aggregated?.chunks_with_category ?? 0;
    const volumeScore = Math.min(1.0, totalChunks / 10.0);
    
    // ========================================================================
    // Proporção de categorias de indecisão (0.0 a 1.0)
    // ========================================================================
    // Quanto maior a proporção de categorias de indecisão, maior a confiança
    const distribution = aggregated?.category_distribution ?? {};
    const indecisionRatio = (distribution.stalling ?? 0) + (distribution.objection_soft ?? 0);
    
    // ========================================================================
    // Consistência temporal (0.0 ou 1.0)
    // ========================================================================
    // Se padrão se mantém consistente ao longo do tempo, aumenta confiança
    const consistencyScore = temporalConsistency ? 1.0 : 0.0;
    
    // ========================================================================
    // Força das métricas de indecisão do Python (0.0 a 1.0)
    // ========================================================================
    // Essas métricas são o sinal mais direto para "indecisão" e devem influenciar
    // o confidence final, senão a heurística fica dependente demais de agregações
    // (stability/trend) que podem demorar a estabilizar.
    const indecisionMetrics = textAnalysis.indecision_metrics;
    const metricsScore = Math.max(
      indecisionMetrics?.indecision_score ?? 0,
      indecisionMetrics?.postponement_likelihood ?? 0,
      indecisionMetrics?.conditional_language_score ?? 0,
    );

    // ========================================================================
    // Calcular confidence combinado (média ponderada)
    // ========================================================================
    // Pesos definidos baseados na importância de cada sinal:
    // - Padrões detectados: 30% (combinação de sinais semânticos)
    // - Métricas do Python: 25% (sinal direto de indecisão)
    // - Estabilidade: 15% (consistência do dominante)
    // - Força da tendência: 10% (quão bem definida é a tendência)
    // - Volume de dados: 10% (mais dados = mais confiança)
    // - Proporção de indecisão: 5% (stalling + objection_soft)
    // - Consistência temporal: 5% (padrão sustentado na janela)
    const confidence = (
      patternsScore * 0.30 +
      metricsScore * 0.25 +
      stability * 0.15 +
      trendStrength * 0.10 +
      volumeScore * 0.10 +
      indecisionRatio * 0.05 +
      consistencyScore * 0.05
    );
    
    // Garantir range [0, 1]
    return Math.max(0.0, Math.min(1.0, confidence));
  }

  // ========================================================================
  // FASE 7: HEURÍSTICA COMPLETA DE DETECÇÃO DE INDECISÃO
  // ========================================================================
  /**
   * Detecta padrão consistente de indecisão do cliente.
   * 
   * Analisa múltiplos sinais para identificar quando o cliente apresenta
   * um padrão consistente de indecisão, caracterizado por:
   * - Postergar decisões
   * - Solicitar mais tempo ou validações
   * - Repetir dúvidas semelhantes
   * - Evitar compromissos claros
   * - Usar linguagem condicional ou aberta
   * 
   * @param state Estado do participante contendo análise de texto e histórico
   * @param evt Evento de análise de texto atual
   * @param now Timestamp atual em milissegundos
   * @returns FeedbackEventPayload se indecisão detectada, null caso contrário
   * 
   * @example
   * ```typescript
   * const feedback = this.detectClientIndecision(state, evt, now);
   * if (feedback) {
   *   this.delivery.publishToHosts(evt.meetingId, feedback);
   * }
   * ```
   *
   * @deprecated LEGACY — replaced by DetectClientIndecision class
   * in a2e2/text-analysis/detect-client-indecision.ts, invoked via runTextAnalysisPipeline().
   * Not called anywhere. Safe to remove.
   */
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
    // Verificar volume mínimo de dados (ajustável por sinal forte recente)
    // ========================================================================
    // Requer pelo menos 5 chunks com categoria para análise confiável.
    // Se houver sinal forte recente, reduzimos o mínimo para não bloquear
    // indecisão em conversas longas com temas mistos.
    const aggregated = textAnalysis.sales_category_aggregated;
    const chunksCount = aggregated?.chunks_with_category ?? 0;
    const minChunksRaw = process.env.SALES_CLIENT_INDECISION_MIN_CHUNKS;
    const minChunksParsed = minChunksRaw ? Number.parseInt(minChunksRaw.replace(/"/g, ''), 10) : 5;
    const minChunks = Number.isFinite(minChunksParsed) ? Math.max(1, minChunksParsed) : 5;
    const hasRecentStrongSignal = this.hasRecentStrongIndecisionSignal(state, now, 30000, 0.30);
    const effectiveMinChunks = hasRecentStrongSignal ? Math.min(minChunks, 2) : minChunks;
    const hasEnoughData = chunksCount >= effectiveMinChunks;
    
    
    this.logger.debug('📊 [INDECISION] Data volume check', {
      chunksCount,
      hasEnoughData,
      threshold: effectiveMinChunks,
      hasRecentStrongSignal,
    });
    
    if (!hasEnoughData) {
      this.logger.debug('❌ [INDECISION] Not enough data');
      return null;
    }
    
    // ========================================================================
    // Detectar padrões semânticos
    // ========================================================================
    const patterns = this.detectIndecisionPatterns(state);
    
    this.logger.debug('🔍 [INDECISION] Patterns detected', {
      decision_postponement: patterns.decision_postponement,
      conditional_language: patterns.conditional_language,
      lack_of_commitment: patterns.lack_of_commitment,
    });
    
    // Verificar se pelo menos um padrão foi detectado
    const hasPattern = Object.values(patterns).some(Boolean);
    if (!hasPattern) {
      this.logger.debug('❌ [INDECISION] No patterns detected');
      return null;
    }
    
    // ========================================================================
    // Calcular consistência temporal
    // ========================================================================
    // Verifica se o padrão se mantém consistente ao longo do tempo
    const temporalConsistency = this.calculateTemporalConsistency(state, now, 60000, hasRecentStrongSignal);
    
    this.logger.debug('⏱️ [INDECISION] Temporal consistency', {
      temporalConsistency,
    });
    
    // ========================================================================
    // Calcular confidence combinado
    // ========================================================================
    // Combina múltiplos sinais para determinar confiança na detecção
    const confidence = this.calculateIndecisionConfidence(state, patterns, temporalConsistency);
    
    this.logger.debug('📊 [INDECISION] Combined confidence', {
      confidence,
      threshold: 0.5,
    });

    // Apenas gera feedback se houver confiança mínima na detecção
    if (confidence < 0.5) {
      this.logger.debug('❌ [INDECISION] Confidence too low', { confidence, threshold: 0.5 });
      return null;
    }
    
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
        representativePhrases = [truncateWithEllipsis(current, maxLen)];
      }
    }
    
    this.logger.debug('💬 [INDECISION] Representative phrases', {
      count: representativePhrases.length,
      phrases: representativePhrases.slice(0, 3), // Mostrar apenas as 3 primeiras
    });
    
    // Não bloquear envio por falta de frases (isso é explicativo/metadata).
    // Se não houver frases, seguimos com metadata vazia.
    
    this.logger.log('✅ [INDECISION] All conditions met! Generating feedback...', {
      confidence,
      patterns,
      temporalConsistency,
      phrasesCount: representativePhrases.length,
    });
    
    this.logger.log('📣 [INDECISION] Will generate humanized feedback', {
      meetingId: evt.meetingId,
      participantId: evt.participantId,
    });
    
    // ========================================================================
    // Construir lista de padrões detectados (para metadata)
    // ========================================================================
    const patternsDetected = Object.entries(patterns)
      .filter(([, detected]) => detected)
      .map(([pattern]) => pattern);
    
    // ========================================================================
    // Construir mensagem curta e direta
    // ========================================================================
    let message: string;
    
    if (patterns.decision_postponement && patterns.lack_of_commitment) {
      message = '⏳ Cliente adiando e evitando compromisso';
    } else if (patterns.decision_postponement) {
      message = '⏳ Cliente adiando a decisão';
    } else if (patterns.lack_of_commitment) {
      message = '🤔 Cliente hesitante';
    } else if (patterns.conditional_language) {
      message = '💭 Indecisão detectada';
    } else {
      message = '⚠️ Sinais de indecisão';
    }
    
    // ========================================================================
    // Construir tips curtas e práticas (máximo 2)
    // ========================================================================
    const tips: string[] = [];
    
    if (patterns.decision_postponement) {
      tips.push('Crie urgência ou ofereça incentivo');
    } else if (patterns.lack_of_commitment) {
      tips.push('Pergunte o que está travando');
    } else if (patterns.conditional_language) {
      tips.push('Descubra a condição real');
    }
    
    // Adicionar uma dica de ação se tiver espaço
    if (tips.length < 2) {
      if (temporalConsistency) {
        tips.push('Mude a abordagem');
      } else {
        tips.push('Proponha próximo passo concreto');
      }
    }
    
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
      participantName: this.index.getParticipantName(evt.meetingId, evt.participantId) ?? undefined,
      window: { start: window.start, end: window.end },
      message,
      tips,
      metadata: {
        confidence: Math.round(confidence * 100) / 100, // Arredondar para 2 casas decimais
        semantic_patterns_detected: patternsDetected,
        representative_phrases: representativePhrases,
        temporal_consistency: temporalConsistency,
        sales_category: textAnalysis.sales_category ?? undefined,
        sales_category_confidence: textAnalysis.sales_category_confidence ?? undefined,
        sales_category_aggregated: aggregated ?? undefined,
        indecision_metrics: textAnalysis.indecision_metrics ?? undefined,
        conditional_keywords_detected: textAnalysis.conditional_keywords_detected ?? undefined,
      },
    };
  }

  // ========================================================================
  // "SOLUÇÃO FOI COMPREENDIDA" (Reformulação do cliente)
  // ========================================================================
  // NOTA: A detecção de "solução compreendida" agora está implementada no
  // pipeline A2E2 via DetectSolutionUnderstood (detect-solution-understood.ts).
  // A implementação anterior neste arquivo foi removida para evitar duplicação
  // e usar a nova arquitetura baseada em textHistory.

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
