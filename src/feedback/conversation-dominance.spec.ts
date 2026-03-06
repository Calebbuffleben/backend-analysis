import { createAggregatorHarness, makeTextAnalysisResult } from './test-utils/sales-detector-harness';

const BASE_TS = 1_700_000_000_000;
const WINDOW_MS = 120_000;

function makeEvt(
  meetingId: string,
  participantId: string,
  timestamp: number,
  text = 'Segmento de fala.',
): ReturnType<typeof makeTextAnalysisResult> {
  return makeTextAnalysisResult({
    meetingId,
    participantId,
    text,
    timestamp,
    analysis: {},
  });
}

describe('conversation_dominance (contract)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS = '0';
    process.env.SALES_SOLUTION_UNDERSTOOD_ENABLED = 'false';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns null when CONVERSATION_DOMINANCE_ENABLED is false', async () => {
    process.env.CONVERSATION_DOMINANCE_ENABLED = 'false';
    const { svc, delivery } = createAggregatorHarness({ 'p1': 'unknown', 'p2': 'unknown' });
    const meetingId = 'm-dom-1';
    const now = BASE_TS;

    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 100_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 80_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 60_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 40_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p2', now - 20_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now));

    const dominanceFeedback = delivery.published
      .map((p) => p.payload)
      .find((p) => p.type === 'conversation_dominance');
    expect(dominanceFeedback).toBeUndefined();
  });

  test('publishes conversation_dominance when one participant has ratio >= 0.75 and total >= 30s', async () => {
    process.env.CONVERSATION_DOMINANCE_ENABLED = 'true';
    process.env.CONVERSATION_DOMINANCE_COOLDOWN_MS = '0';
    const { svc, delivery } = createAggregatorHarness({ 'p1': 'unknown', 'p2': 'unknown' });
    const meetingId = 'm-dom-2';
    const now = BASE_TS;

    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 100_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 80_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 60_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 40_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 20_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p2', now - 10_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p2', now));

    const dominanceFeedback = delivery.published
      .map((p) => p.payload)
      .find((p) => p.type === 'conversation_dominance');
    expect(dominanceFeedback).toBeDefined();
    expect(dominanceFeedback?.type).toBe('conversation_dominance');
    expect(dominanceFeedback?.severity).toBe('warning');
    expect(dominanceFeedback?.meetingId).toBe(meetingId);
    expect(dominanceFeedback?.participantId).toBe('p1');
    expect(dominanceFeedback?.metadata?.dominant_time_ms).toBeDefined();
    expect(dominanceFeedback?.metadata?.total_ms).toBeDefined();
    expect(dominanceFeedback?.metadata?.ratio).toBeGreaterThanOrEqual(0.75);
    expect((dominanceFeedback?.metadata?.total_ms ?? 0)).toBeGreaterThanOrEqual(30_000);
  });

  test('returns null when total < MIN_TOTAL_MS (30s)', async () => {
    process.env.CONVERSATION_DOMINANCE_ENABLED = 'true';
    process.env.CONVERSATION_DOMINANCE_MIN_TOTAL_MS = '30000';
    process.env.CONVERSATION_DOMINANCE_COOLDOWN_MS = '0';
    const { svc, delivery } = createAggregatorHarness({ 'p1': 'unknown', 'p2': 'unknown' });
    const meetingId = 'm-dom-3';
    const now = BASE_TS;

    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 5_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p2', now - 2_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now));

    const dominanceFeedback = delivery.published
      .map((p) => p.payload)
      .find((p) => p.type === 'conversation_dominance');
    expect(dominanceFeedback).toBeUndefined();
  });

  test('returns null when no single participant has ratio >= 0.75 (balanced)', async () => {
    process.env.CONVERSATION_DOMINANCE_ENABLED = 'true';
    process.env.CONVERSATION_DOMINANCE_COOLDOWN_MS = '0';
    const { svc, delivery } = createAggregatorHarness({ 'p1': 'unknown', 'p2': 'unknown' });
    const meetingId = 'm-dom-4';
    const now = BASE_TS;

    await svc.handleTextAnalysis(makeEvt(meetingId, 'p2', now - 90_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p2', now - 70_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p2', now - 50_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 30_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 20_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p2', now));

    const dominanceFeedback = delivery.published
      .map((p) => p.payload)
      .find((p) => p.type === 'conversation_dominance');
    expect(dominanceFeedback).toBeUndefined();
  });

  test('respects meeting cooldown (does not fire again within cooldown)', async () => {
    process.env.CONVERSATION_DOMINANCE_ENABLED = 'true';
    process.env.CONVERSATION_DOMINANCE_COOLDOWN_MS = '300000';
    const { svc, delivery } = createAggregatorHarness({ 'p1': 'unknown', 'p2': 'unknown' });
    const meetingId = 'm-dom-5';
    const now = BASE_TS;

    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 100_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 80_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 60_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 40_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p2', now - 10_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now));

    const first = delivery.published.filter((p) => p.payload.type === 'conversation_dominance').length;
    expect(first).toBe(1);

    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now + 1000));
    const second = delivery.published.filter((p) => p.payload.type === 'conversation_dominance').length;
    expect(second).toBe(1);
  });

  test('pipeline order: indecision wins over conversation_dominance when both could fire', async () => {
    process.env.CONVERSATION_DOMINANCE_ENABLED = 'true';
    process.env.CONVERSATION_DOMINANCE_COOLDOWN_MS = '0';
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS = '0';
    const { svc, delivery } = createAggregatorHarness({ 'p1': 'unknown', 'p2': 'unknown' });
    const meetingId = 'm-dom-6';
    const now = BASE_TS;

    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 100_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 80_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 60_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p1', now - 40_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'p2', now - 10_000));
    const evtWithIndecision = makeTextAnalysisResult({
      meetingId,
      participantId: 'p2',
      timestamp: now,
      text: 'Talvez eu precise pensar melhor antes de decidir.',
      analysis: {
        sales_category: 'objection_soft',
        sales_category_confidence: 0.9,
        sales_category_intensity: 0.5,
        indecision_metrics: {
          indecision_score: 0.9,
          postponement_likelihood: 0.9,
          conditional_language_score: 0.9,
        },
      },
    });
    await svc.handleTextAnalysis(evtWithIndecision);

    const lastPublished = delivery.published[delivery.published.length - 1]?.payload;
    expect(lastPublished?.type).toBe('sales_client_indecision');
  });
});
