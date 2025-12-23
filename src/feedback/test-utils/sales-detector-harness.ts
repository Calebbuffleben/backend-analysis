import { FeedbackAggregatorService } from '../feedback.aggregator.service';
import type { FeedbackDeliveryService } from '../feedback.delivery.service';
import type { FeedbackEventPayload } from '../feedback.types';
import type { ParticipantIndexService } from '../../livekit/participant-index.service';
import type { TextAnalysisResult } from '../../pipeline/text-analysis.service';

export type ParticipantRole = 'host' | 'guest' | 'unknown';

export type PublishedFeedback = {
  meetingId: string;
  payload: FeedbackEventPayload;
};

export class TestDelivery {
  public readonly published: PublishedFeedback[] = [];

  publishToHosts(meetingId: string, payload: FeedbackEventPayload): void {
    this.published.push({ meetingId, payload });
  }
}

export function createAggregatorHarness(rolesByParticipant: Record<string, ParticipantRole>): {
  svc: FeedbackAggregatorService;
  delivery: TestDelivery;
} {
  const delivery = new TestDelivery();
  const indexLike: Pick<ParticipantIndexService, 'getParticipantRole' | 'getParticipantName'> = {
    getParticipantRole: (_meetingId: string, participantId: string) =>
      rolesByParticipant[participantId] ?? 'unknown',
    getParticipantName: () => undefined,
  };

  const svc = new FeedbackAggregatorService(
    delivery as unknown as FeedbackDeliveryService,
    indexLike as unknown as ParticipantIndexService,
  );

  return { svc, delivery };
}

export type MakeTextAnalysisResultParams = {
  meetingId: string;
  participantId: string;
  text: string;
  timestamp: number;
  confidence?: number;
  embedding?: number[];
  analysis?: Partial<TextAnalysisResult['analysis']>;
};

export function makeTextAnalysisResult(params: MakeTextAnalysisResultParams): TextAnalysisResult {
  const embedding = params.analysis?.embedding ?? params.embedding ?? [1, 0];

  const baseAnalysis: TextAnalysisResult['analysis'] = {
    intent: 'ask_info',
    intent_confidence: 0.6,
    topic: 'general',
    topic_confidence: 0.5,
    speech_act: 'statement',
    speech_act_confidence: 0.7,
    keywords: [],
    entities: [],
    sentiment: 'neutral',
    sentiment_score: 0.5,
    urgency: 0.5,
    embedding,
    sales_category: null,
    sales_category_confidence: null,
    sales_category_intensity: null,
    sales_category_ambiguity: null,
    sales_category_flags: null,
    sales_category_aggregated: null,
    sales_category_transition: null,
    sales_category_trend: null,
    conditional_keywords_detected: [],
    indecision_metrics: null,
    reformulation_markers_detected: [],
    reformulation_marker_score: 0,
  };

  return {
    meetingId: params.meetingId,
    participantId: params.participantId,
    text: params.text,
    timestamp: params.timestamp,
    confidence: params.confidence ?? 1,
    analysis: {
      ...baseAnalysis,
      ...params.analysis,
      embedding,
    },
  };
}


