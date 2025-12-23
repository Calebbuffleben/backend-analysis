import { FeedbackAggregatorService } from './feedback.aggregator.service';
import type { FeedbackDeliveryService } from './feedback.delivery.service';
import type { ParticipantIndexService } from '../livekit/participant-index.service';
import type { ParticipantState } from './a2e2/types';
import type { TextAnalysisResult } from '../pipeline/text-analysis.service';

type PrivateApi = {
  updateSolutionContextFromTurn: (evt: TextAnalysisResult, now: number) => void;
  detectClientSolutionUnderstood: (
    state: ParticipantState,
    evt: TextAnalysisResult,
    now: number,
  ) => { type: string } | null;
  detectReformulationMarkers: (text: string) => string[];
  cosineSimilarity: (a: number[], b: number[]) => number;
  meanEmbedding: (vectors: number[][]) => number[] | null;
  computeSolutionExplanationStrength: (evt: TextAnalysisResult) => number;
};

function makeService(index: ParticipantIndexService): PrivateApi {
  const delivery = {} as unknown as FeedbackDeliveryService;
  const svc = new FeedbackAggregatorService(delivery, index);
  return svc as unknown as PrivateApi;
}

function makeState(): ParticipantState {
  return {
    samples: [],
    ema: { emotions: new Map() },
    cooldownUntilByType: new Map<string, number>(),
  };
}

function makeEvt(params: {
  meetingId: string;
  participantId: string;
  text: string;
  timestamp: number;
  embedding: number[];
  keywords?: string[];
  sales_category?: string | null;
  speech_act?: string;
}): TextAnalysisResult {
  return {
    meetingId: params.meetingId,
    participantId: params.participantId,
    text: params.text,
    timestamp: params.timestamp,
    confidence: 1,
    analysis: {
      intent: 'ask_info',
      intent_confidence: 0.6,
      topic: 'general',
      topic_confidence: 0.5,
      speech_act: params.speech_act ?? 'statement',
      speech_act_confidence: 0.7,
      keywords: params.keywords ?? [],
      entities: [],
      sentiment: 'neutral',
      sentiment_score: 0.5,
      urgency: 0.5,
      embedding: params.embedding,
      sales_category: params.sales_category ?? null,
      sales_category_confidence: 0.9,
      sales_category_intensity: 0.9,
      sales_category_ambiguity: 0.2,
      sales_category_flags: null,
      sales_category_aggregated: null,
      sales_category_transition: null,
      sales_category_trend: null,
      conditional_keywords_detected: [],
      indecision_metrics: null,
    },
  };
}

describe('sales_solution_understood detector', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SALES_SOLUTION_UNDERSTOOD_ENABLED = 'true';
    process.env.SALES_SOLUTION_UNDERSTOOD_DEBUG = 'false';
    process.env.SALES_SOLUTION_UNDERSTOOD_THRESHOLD = '0.6';
    process.env.SALES_SOLUTION_UNDERSTOOD_MIN_REFORMULATION_CHARS = '10';
    process.env.SALES_SOLUTION_UNDERSTOOD_COOLDOWN_MS = '0';
    process.env.SALES_SOLUTION_CONTEXT_WINDOW_MS = '90000';
    process.env.SALES_SOLUTION_CONTEXT_MAX_ENTRIES = '12';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('detectReformulationMarkers finds markers', () => {
    const index = {
      getParticipantRole: () => 'unknown',
      getParticipantName: () => undefined,
    } as unknown as ParticipantIndexService;
    const svc = makeService(index);
    const markers = svc.detectReformulationMarkers('Ou seja, deixa eu ver se entendi...');
    expect(markers).toContain('ou seja');
    expect(markers).toContain('deixa eu ver se entendi');
  });

  test('cosineSimilarity behaves for simple vectors', () => {
    const index = {
      getParticipantRole: () => 'unknown',
      getParticipantName: () => undefined,
    } as unknown as ParticipantIndexService;
    const svc = makeService(index);
    expect(svc.cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(svc.cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test('computeSolutionExplanationStrength is higher for explanation-like text', () => {
    const index = {
      getParticipantRole: () => 'unknown',
      getParticipantName: () => undefined,
    } as unknown as ParticipantIndexService;
    const svc = makeService(index);
    const base = {
      meetingId: 'm',
      participantId: 'p',
      timestamp: Date.now(),
      embedding: [1, 0],
    };
    const evt1 = makeEvt({
      ...base,
      text: 'Ok.',
      sales_category: 'stalling',
      speech_act: 'statement',
    });
    const evt2 = makeEvt({
      ...base,
      text: 'Funciona assim: a gente faz X, depois Y, e você consegue Z na prática.',
      sales_category: 'value_exploration',
      speech_act: 'statement',
    });
    expect(svc.computeSolutionExplanationStrength(evt2)).toBeGreaterThan(svc.computeSolutionExplanationStrength(evt1));
  });

  test('end-to-end triggers when guest reformulates host explanation with high similarity', () => {
    const rolesByParticipant = new Map<string, 'host' | 'guest' | 'unknown'>([
      ['host-1', 'host'],
      ['guest-1', 'guest'],
    ]);
    const index = {
      getParticipantRole: (_m: string, pid: string) => rolesByParticipant.get(pid) ?? 'unknown',
      getParticipantName: () => undefined,
    } as unknown as ParticipantIndexService;
    const svc = makeService(index);

    const meetingId = 'meeting-1';
    const now = Date.now();

    // Host explains solution (adds context)
    const hostEvt = makeEvt({
      meetingId,
      participantId: 'host-1',
      timestamp: now,
      text: 'Funciona assim: a gente integra X, automatiza Y e você reduz Z.',
      embedding: [1, 0],
      keywords: ['integra', 'automatiza', 'reduz'],
      sales_category: 'value_exploration',
      speech_act: 'statement',
    });
    svc.updateSolutionContextFromTurn(hostEvt, now);

    // Guest reformulates with marker + similar embedding + overlap
    const guestEvt = makeEvt({
      meetingId,
      participantId: 'guest-1',
      timestamp: now + 1000,
      text: 'Ou seja, se eu entendi, vocês integram e automatizam pra reduzir o trabalho.',
      embedding: [0.99, 0.01],
      keywords: ['integra', 'automatiza', 'reduz'],
      sales_category: 'information_gathering',
      speech_act: 'confirmation',
    });

    const state = makeState();
    const feedback = svc.detectClientSolutionUnderstood(state, guestEvt, now + 1000);
    expect(feedback).not.toBeNull();
    expect(feedback?.type).toBe('sales_solution_understood');
  });
});


