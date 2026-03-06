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

describe('sales_seller_talking_too_much (contract)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS = '0';
    process.env.SALES_SOLUTION_UNDERSTOOD_ENABLED = 'false';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns null when SALES_SELLER_TALKING_ENABLED is false', async () => {
    process.env.SALES_SELLER_TALKING_ENABLED = 'false';
    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });
    const meetingId = 'm-seller-1';
    const now = BASE_TS;

    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 100_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 80_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 60_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 40_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'guest-1', now - 20_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now));

    const sellerFeedback = delivery.published
      .map((p) => p.payload)
      .find((p) => p.type === 'sales_seller_talking_too_much');
    expect(sellerFeedback).toBeUndefined();
  });

  test('publishes sales_seller_talking_too_much when ratio >= 0.75 and total >= 30s', async () => {
    process.env.SALES_SELLER_TALKING_ENABLED = 'true';
    process.env.SALES_SELLER_TALKING_COOLDOWN_MS = '0';
    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });
    const meetingId = 'm-seller-2';
    const now = BASE_TS;

    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 100_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 80_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 60_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 40_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 20_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'guest-1', now - 10_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'guest-1', now));

    const sellerFeedback = delivery.published
      .map((p) => p.payload)
      .find((p) => p.type === 'sales_seller_talking_too_much');
    expect(sellerFeedback).toBeDefined();
    expect(sellerFeedback?.type).toBe('sales_seller_talking_too_much');
    expect(sellerFeedback?.severity).toBe('warning');
    expect(sellerFeedback?.meetingId).toBe(meetingId);
    expect(sellerFeedback?.participantId).toBe('host-1');
    expect(sellerFeedback?.metadata?.seller_time_ms).toBeDefined();
    expect(sellerFeedback?.metadata?.client_time_ms).toBeDefined();
    expect(sellerFeedback?.metadata?.total_ms).toBeDefined();
    expect(sellerFeedback?.metadata?.ratio).toBeGreaterThanOrEqual(0.75);
    expect((sellerFeedback?.metadata?.total_ms ?? 0)).toBeGreaterThanOrEqual(30_000);
  });

  test('returns null when total < MIN_TOTAL_MS (30s)', async () => {
    process.env.SALES_SELLER_TALKING_ENABLED = 'true';
    process.env.SALES_SELLER_TALKING_MIN_TOTAL_MS = '30000';
    process.env.SALES_SELLER_TALKING_COOLDOWN_MS = '0';
    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });
    const meetingId = 'm-seller-3';
    const now = BASE_TS;

    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 5_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'guest-1', now - 2_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now));

    const sellerFeedback = delivery.published
      .map((p) => p.payload)
      .find((p) => p.type === 'sales_seller_talking_too_much');
    expect(sellerFeedback).toBeUndefined();
  });

  test('returns null when ratio < 0.75 (guest has more speaking time)', async () => {
    process.env.SALES_SELLER_TALKING_ENABLED = 'true';
    process.env.SALES_SELLER_TALKING_COOLDOWN_MS = '0';
    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });
    const meetingId = 'm-seller-4';
    const now = BASE_TS;

    await svc.handleTextAnalysis(makeEvt(meetingId, 'guest-1', now - 90_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'guest-1', now - 70_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'guest-1', now - 50_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 20_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'guest-1', now));

    const sellerFeedback = delivery.published
      .map((p) => p.payload)
      .find((p) => p.type === 'sales_seller_talking_too_much');
    expect(sellerFeedback).toBeUndefined();
  });

  test('respects meeting cooldown (does not fire again within cooldown)', async () => {
    process.env.SALES_SELLER_TALKING_ENABLED = 'true';
    process.env.SALES_SELLER_TALKING_COOLDOWN_MS = '300000';
    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });
    const meetingId = 'm-seller-5';
    const now = BASE_TS;

    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 100_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 80_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 60_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 40_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'guest-1', now - 10_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now));

    const first = delivery.published.filter((p) => p.payload.type === 'sales_seller_talking_too_much').length;
    expect(first).toBe(1);

    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now + 1000));
    const second = delivery.published.filter((p) => p.payload.type === 'sales_seller_talking_too_much').length;
    expect(second).toBe(1);
  });

  test('pipeline order: indecision wins over seller_talking when both could fire', async () => {
    process.env.SALES_SELLER_TALKING_ENABLED = 'true';
    process.env.SALES_SELLER_TALKING_COOLDOWN_MS = '0';
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS = '0';
    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });
    const meetingId = 'm-seller-6';
    const now = BASE_TS;

    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 100_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 80_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 60_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'host-1', now - 40_000));
    await svc.handleTextAnalysis(makeEvt(meetingId, 'guest-1', now - 10_000));
    const evtWithIndecision = makeTextAnalysisResult({
      meetingId,
      participantId: 'guest-1',
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
