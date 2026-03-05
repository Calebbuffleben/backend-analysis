import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FeedbackDeliveryService } from './feedback.delivery.service';
import { FeedbackMeetingStateService } from './feedback-meeting-state.service';
import { FeedbackEventPayload, FeedbackIngestionEvent } from './feedback.types';
import { ParticipantIndexService } from '../livekit/participant-index.service';
import { runA2E2Pipeline } from './a2e2/pipeline/run-a2e2-pipeline';
import { runTextAnalysisPipeline } from './a2e2/pipeline/run-text-analysis-pipeline';
import { TextAnalysisResult } from '../pipeline/text-analysis.service';
import type { DetectionContext, ParticipantState, Sample, TextHistoryEntry } from './a2e2/types';
import { FeedbackParticipantStateService } from './feedback-participant-state.service';
import { computeWindow, pruneOldSamples, updateEma, updateSpeakerTracking } from './helpers';
import { makeFeedbackId } from './utils/id';
import { textSimilar } from './utils/text-similarity';
import { normalizeEmbedding } from './utils/embedding';

/**
 * Thresholds usados pelo agregador (janela curta para speaker tracking, prune e EMA).
 * Janelas longas e detecção A2E2 usam ./a2e2/thresholds/thresholds.ts.
 */
const THRESHOLDS = {
  windows: {
    short: 3000, // 3s (speaker tracking)
    prune: 65000, // 65s
  },
  ema: {
    alpha: 0.3,
  },
};

@Injectable()
export class FeedbackAggregatorService {
  private readonly logger = new Logger(FeedbackAggregatorService.name);
  /** Serializes handleTextAnalysis per participant so cooldown set by one event is visible to the next. */
  private readonly textAnalysisLockByKey = new Map<string, Promise<void>>();
  private readonly shortWindowMs = THRESHOLDS.windows.short;
  private readonly pruneHorizonMs = THRESHOLDS.windows.prune;
  private readonly emaAlpha = THRESHOLDS.ema.alpha;

  constructor(
    private readonly delivery: FeedbackDeliveryService,
    private readonly index: ParticipantIndexService,
    private readonly meetingState: FeedbackMeetingStateService,
    private readonly participantState: FeedbackParticipantStateService,
  ) {}

  private makeId(): string {
    return makeFeedbackId();
  }

  @OnEvent('feedback.ingestion', { async: true })
  handleIngestion(evt: FeedbackIngestionEvent): void {
    const participantId = evt.participantId ?? '';
    if (!participantId) return;
    const includeHost = (process.env.FEEDBACK_INCLUDE_HOST || 'false') === 'true';
    if (evt.participantRole === 'host' && !includeHost) {
      return;
    }
    const state = this.participantState.getOrCreateState(evt.meetingId, participantId);
    const sample: Sample = {
      ts: evt.ts,
      speech: evt.prosody.speechDetected,
      valence: evt.prosody.valence,
      arousal: evt.prosody.arousal,
      rmsDbfs: evt.signal?.rmsDbfs,
      emotions: evt.prosody.emotions,
    };
    state.samples.push(sample);
    pruneOldSamples(state, evt.ts, this.pruneHorizonMs);
    updateEma(state, sample, this.emaAlpha);

    // A2E2 pipeline (./a2e2/pipeline/run-a2e2-pipeline.ts)
    updateSpeakerTracking(evt.meetingId, evt.ts, {
      participantState: this.participantState,
      meetingState: this.meetingState,
      shortWindowMs: this.shortWindowMs,
    });
    const ctx = this.createDetectionContext(evt.meetingId, participantId, evt.ts);
    const feedback = runA2E2Pipeline(state, ctx);
    if (feedback) {
      this.delivery.publishToHosts(evt.meetingId, feedback);
    }
  }

  @OnEvent('text.analysis', { async: true })
  async handleTextAnalysis(evt: TextAnalysisResult): Promise<void> {
    const t8_handler_start = Date.now();

    const participantId = evt.participantId ?? '';
    const state = this.participantState.getOrCreateState(evt.meetingId, participantId);
    const key = this.participantState.key(evt.meetingId, participantId);

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
    const state = this.participantState.getState(evt.meetingId, participantId);
    if (!state) return;
    const now = evt.timestamp;

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

    const salesTextAnalysisFeedback = runTextAnalysisPipeline(state, ctx);
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

    if (feedback || salesTextAnalysisFeedback) {
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
      feedbacks_generated: { a2e2: !!feedback, text_analysis: !!salesTextAnalysisFeedback },
    });
  }

  private updateStateWithTextAnalysis(
    state: ParticipantState,
    evt: TextAnalysisResult,
  ): void {
    // Mantém histórico dos últimos 20 textos analisados para permitir:
    // - Extração de frases representativas
    // - Análise temporal de padrões
    // - Detecção de consistência ao longo do tempo
    // ========================================================================
    const maxHistorySize = 20;

    // Normalize embedding: Python sends list of floats; if we get a scalar (e.g. 0.7 or 0) we identify and skip
    const normalizedEmbedding = normalizeEmbedding(evt.analysis.embedding, {
      logger: this.logger,
      meetingId: evt.meetingId,
      participantId: evt.participantId,
    });

    // Criar entrada no histórico
    const historyEntry: TextHistoryEntry = {
      text: evt.text,
      timestamp: evt.timestamp,
      received_at: Date.now(),
      sales_category: evt.analysis.sales_category ?? null,
      sales_category_confidence: evt.analysis.sales_category_confidence ?? null,
      sales_category_intensity: evt.analysis.sales_category_intensity ?? null,
      sales_category_ambiguity: evt.analysis.sales_category_ambiguity ?? null,
      embedding: normalizedEmbedding ?? undefined,
      keywords: evt.analysis.keywords ?? undefined,
    };
    
    // Inicializar histórico se não existir
    const currentHistory = state.textAnalysis?.textHistory ?? [];
    
    // Adicionar nova entrada ao histórico
    const updatedHistory = [...currentHistory, historyEntry];
    
    // Manter apenas últimos N textos (limitar tamanho do histórico)
    const prunedHistory = updatedHistory.length > maxHistorySize
      ? updatedHistory.slice(-maxHistorySize)
      : updatedHistory;
    
    // Garantir que o chunk atual foi adicionado corretamente ao histórico
    const lastEntry = prunedHistory[prunedHistory.length - 1];
    const isCurrentChunkInHistory = lastEntry && 
      lastEntry.text === evt.text && 
      lastEntry.timestamp === evt.timestamp;
    
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
      embedding: normalizedEmbedding,
      // Categorias de vendas classificadas com SBERT
      // Estes campos são opcionais e podem ser null se SBERT não estiver configurado
      // ou se nenhuma categoria foi detectada com confiança suficiente
      sales_category: evt.analysis.sales_category ?? undefined,
      sales_category_confidence: evt.analysis.sales_category_confidence ?? undefined,
      sales_category_intensity: evt.analysis.sales_category_intensity ?? undefined,
      sales_category_ambiguity: evt.analysis.sales_category_ambiguity ?? undefined,
      sales_category_best_score: evt.analysis.sales_category_best_score ?? undefined,
      sales_category_scores: evt.analysis.sales_category_scores ?? undefined,
      sales_category_top_3: evt.analysis.sales_category_top_3 ?? undefined,
      // Keywords condicionais detectadas (FASE 9)
      conditional_keywords_detected: evt.analysis.conditional_keywords_detected ?? undefined,
      // Métricas de indecisão (FASE 10)
      indecision_metrics: evt.analysis.indecision_metrics ?? undefined,
      // Histórico de textos (FASE 1)
      textHistory: prunedHistory,
    };
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
      inCooldown: (st: ParticipantState, type: string, n: number) => this.participantState.inCooldown(st, type, n),
      inGlobalCooldown: (st: ParticipantState, n: number) => this.participantState.inGlobalCooldown(st, n),
      setCooldown: (st: ParticipantState, type: string, n: number, ms: number) =>
        this.participantState.setCooldown(st, type, n, ms),
      inCooldownMeeting: (mid, type, n) => this.meetingState.inCooldownMeeting(mid, type, n),
      setCooldownMeeting: (mid, type, n, ms) => this.meetingState.setCooldownMeeting(mid, type, n, ms),
      makeId: () => this.makeId(),
      window: (st, n, ms) => computeWindow(st, n, ms),
      getParticipantsForMeeting: (mid) => this.participantState.participantsForMeeting(mid),
      getParticipantState: (mid, pid) => this.participantState.getState(mid, pid),
      getPostInterruptionCandidates: (mid) => this.meetingState.getPostInterruptionCandidates(mid),
      updatePostInterruptionCandidates: (mid, candidates) => this.meetingState.updatePostInterruptionCandidates(mid, candidates),
      getOverlapHistory: (mid) => this.meetingState.getOverlapHistory(mid),
      updateOverlapHistory: (mid, timestamps) => this.meetingState.updateOverlapHistory(mid, timestamps),
      getLastOverlapSampleAt: (mid) => this.meetingState.getLastOverlapSampleAt(mid),
      setLastOverlapSampleAt: (mid, timestamp) => this.meetingState.setLastOverlapSampleAt(mid, timestamp),
      getLastSpeaker: (mid) => this.meetingState.getLastSpeaker(mid),
    };
  }
}
