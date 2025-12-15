export type ParticipantRole = 'host' | 'guest' | 'unknown';

export interface FeedbackIngestionEvent {
  version: 1;
  meetingId: string;
  roomName?: string;
  trackSid?: string;
  participantId?: string;
  participantRole: ParticipantRole;
  ts: number; // ms epoch at ingestion
  prosody: {
    speechDetected: boolean;
    valence?: number;
    arousal?: number;
    emotions?: Record<string, number>; // Map of specific emotion scores (0..1)
    warnings: string[];
  };
  signal?: {
    rmsDbfs?: number;
  };
  debug: {
    rawPreview: string;
    rawHash: string; // sha256 hex
  };
}

export interface AggregatedWindowEvent {
  meetingId: string;
  participantId: string;
  window: { start: number; end: number };
  metrics: {
    speechCoverage: number; // 0..1
    meanRmsDbfs?: number;
    valenceEMA?: number;
    arousalEMA?: number;
  };
}

export type FeedbackSeverity = 'info' | 'warning' | 'critical';

export interface FeedbackEventPayload {
  id: string;
  type:
    | 'volume_baixo'
    | 'volume_alto'
    | 'silencio_prolongado'
    | 'tendencia_emocional_negativa'
    | 'engajamento_baixo'
    | 'overlap_fala'
    | 'monologo_prolongado'
    | 'frustracao_crescente'
    | 'entusiasmo_alto'
    | 'monotonia_prosodica'
    | 'energia_grupo_baixa'
    | 'interrupcoes_frequentes'
    | 'polarizacao_emocional'
    | 'efeito_pos_interrupcao'
    | 'ritmo_acelerado'
    | 'ritmo_pausado'
    | 'hostilidade'
    | 'tedio'
    | 'confusao'
    | 'serenidade'
    | 'conexao'
    | 'tristeza'
    | 'estado_mental';
  severity: FeedbackSeverity;
  ts: number;
  meetingId: string;
  participantId: string;
  participantName?: string;
  window: { start: number; end: number };
  message: string;
  tips?: string[];
  metadata?: {
    rmsDbfs?: number;
    speechCoverage?: number;
    valenceEMA?: number;
    arousalEMA?: number;
  };
}

export interface TextAnalysisEvent {
  meetingId: string;
  participantId: string;
  text: string;
  analysis: {
    intent: string;
    intent_confidence: number;
    topic: string;
    topic_confidence: number;
    speech_act: string;
    speech_act_confidence: number;
    keywords: string[];
    entities: string[];
    sentiment: string;
    sentiment_score: number;
    urgency: number;
    embedding: number[];
  };
  timestamp: number;
  confidence: number;
}
