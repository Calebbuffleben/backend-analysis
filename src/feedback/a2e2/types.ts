/**
 * Tipos compartilhados para a Arquitetura Emocional 2.0 (A2E2)
 * 
 * Este arquivo centraliza os tipos usados por todas as camadas da pipeline A2E2.
 */

/**
 * Tipo para amostra de dados do participante
 */
export type Sample = {
  ts: number;
  speech: boolean;
  valence?: number;
  arousal?: number;
  rmsDbfs?: number;
  emotions?: Record<string, number>;
};

/**
 * Tipo para estado do participante
 */
export type ParticipantState = {
  samples: Sample[];
  ema: {
    valence?: number;
    arousal?: number;
    rms?: number;
    emotions: Map<string, number>;
  };
  cooldownUntilByType: Map<string, number>;
  lastFeedbackAt?: number;
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
 * Tipo para contexto de detecção
 * 
 * Fornece todas as funções e dados necessários para os detectores funcionarem.
 * 
 * Nota: Algumas propriedades são opcionais porque nem todos os detectores precisam delas.
 * Detectores que precisam de propriedades opcionais devem verificar se elas existem antes de usar.
 */
export type DetectionContext = {
  meetingId: string;
  participantId: string;
  now: number;
  getParticipantName: (meetingId: string, participantId: string) => string | undefined;
  getParticipantRole?: (meetingId: string, participantId: string) => 'host' | 'guest' | 'unknown' | string | undefined;
  inCooldown: (state: ParticipantState, type: string, now: number) => boolean;
  inGlobalCooldown: (state: ParticipantState, now: number) => boolean;
  setCooldown: (state: ParticipantState, type: string, now: number, cooldownMs: number) => void;
  inCooldownMeeting?: (meetingId: string, type: string, now: number) => boolean;
  setCooldownMeeting?: (meetingId: string, type: string, now: number, cooldownMs: number) => void;
  makeId: () => string;
  window: (
    state: ParticipantState,
    now: number,
    windowMs: number,
  ) => {
    start: number;
    end: number;
    samplesCount: number;
    speechCount: number;
    meanRmsDbfs?: number;
  };
  getParticipantsForMeeting?: (meetingId: string) => Array<[string, ParticipantState]>;
  getParticipantState?: (meetingId: string, participantId: string) => ParticipantState | undefined;
  getPostInterruptionCandidates?: (meetingId: string) => Array<{ ts: number; interruptedId: string; valenceBefore?: number }> | undefined;
  updatePostInterruptionCandidates?: (meetingId: string, candidates: Array<{ ts: number; interruptedId: string; valenceBefore?: number }>) => void;
  getOverlapHistory?: (meetingId: string) => number[] | undefined;
  updateOverlapHistory?: (meetingId: string, timestamps: number[]) => void;
  getLastOverlapSampleAt?: (meetingId: string) => number | undefined;
  setLastOverlapSampleAt?: (meetingId: string, timestamp: number) => void;
  // FASE 10.3.1: Métodos para histórico de emoções e contexto
  getRecentEmotions?: (state: ParticipantState, windowMs: number, now: number) => Array<{ type: string; ts: number }>;
  getEmotionTrend?: (state: ParticipantState, emotion: string, windowMs: number, now: number) => 'increasing' | 'decreasing' | 'stable';
  getTensionLevel?: (state: ParticipantState) => 'high' | 'moderate' | 'low';
};

