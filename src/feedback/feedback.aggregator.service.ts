import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FeedbackDeliveryService } from './feedback.delivery.service';
import { FeedbackEventPayload, FeedbackIngestionEvent } from './feedback.types';
import { ParticipantIndexService } from '../livekit/participant-index.service';
import { runA2E2Pipeline } from './a2e2/pipeline/run-a2e2-pipeline';
import { TextAnalysisResult } from '../pipeline/text-analysis.service';
import type { DetectionContext } from './a2e2/types';

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
  lastFeedbackAt?: number; // Global cooldown to prevent spam
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
  ) {}

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
  handleTextAnalysis(evt: TextAnalysisResult): void {
    const key = this.key(evt.meetingId, evt.participantId);
    let state = this.byKey.get(key);

    if (!state) {
      this.logger.warn(`No state found for ${key}, creating new state`);
      state = this.initState();
      this.byKey.set(key, state);
    }

    this.updateStateWithTextAnalysis(state, evt);

    // Re-executar pipeline A2E2 com dados combinados
    const now = evt.timestamp;
    const ctx = this.createDetectionContext(evt.meetingId, evt.participantId, now);
    const feedback = runA2E2Pipeline(state, ctx);

    if (feedback) {
      this.delivery.publishToHosts(evt.meetingId, feedback);
    }
  }

  private updateStateWithTextAnalysis(
    state: ParticipantState,
    evt: TextAnalysisResult,
  ): void {
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
    };

    this.logger.debug(
      `Updated text analysis for ${evt.meetingId}/${evt.participantId}`,
      {
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
      },
    );
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
    const rnd = Math.floor(Math.random() * 1e9).toString(36);
    return `${Date.now().toString(36)}-${rnd}`;
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
