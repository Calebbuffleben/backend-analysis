import { createAggregatorHarness, makeTextAnalysisResult } from './test-utils/sales-detector-harness';

describe('sales_client_indecision (contract)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Keep solution-understood disabled so these tests focus on indecision only.
    process.env.SALES_SOLUTION_UNDERSTOOD_ENABLED = 'false';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('publishes sales_client_indecision when strong indecision signals are present', () => {
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS = '0';

    const { svc, delivery } = createAggregatorHarness({ 'guest-1': 'guest' });

    const meetingId = 'm-indecision-1';
    const now = 1_700_000_000_000;

    const evt = makeTextAnalysisResult({
      meetingId,
      participantId: 'guest-1',
      timestamp: now,
      text: 'Talvez eu precise pensar melhor e avaliar isso com calma antes de decidir.',
      analysis: {
        keywords: ['talvez', 'pensar', 'avaliar'],
        sales_category: 'objection_soft',
        sales_category_confidence: 0.9,
        sales_category_intensity: 0.7,
        sales_category_ambiguity: 0.95,
        sales_category_flags: {
          price_window_open: false,
          decision_signal_strong: false,
          ready_to_close: false,
          indecision_detected: true,
          decision_postponement_signal: true,
          conditional_language_signal: true,
        },
        sales_category_aggregated: {
          dominant_category: 'stalling',
          chunks_with_category: 10,
          total_chunks: 10,
          stability: 0.8,
          category_distribution: { stalling: 0.7, objection_soft: 0.1 },
        },
        sales_category_trend: {
          trend: 'stable',
          trend_strength: 0.9,
          current_stage: 2,
          velocity: 0.05,
        },
        conditional_keywords_detected: ['talvez', 'pensar melhor'],
        indecision_metrics: {
          indecision_score: 0.9,
          postponement_likelihood: 0.9,
          conditional_language_score: 0.9,
        },
      },
    });

    svc.handleTextAnalysis(evt);

    const indecision = delivery.published
      .map((p) => p.payload)
      .find((p) => p.type === 'sales_client_indecision');

    expect(indecision).toBeDefined();
    expect(indecision?.severity).toBe('warning');
    expect(indecision?.meetingId).toBe(meetingId);
    expect(indecision?.participantId).toBe('guest-1');

    // Contract: indecision feedback should include at least one detected pattern and a confidence number.
    expect((indecision?.metadata?.semantic_patterns_detected ?? []).length).toBeGreaterThan(0);
    expect(typeof indecision?.metadata?.confidence).toBe('number');
  });

  test('does not publish sales_client_indecision when no indecision patterns are present', () => {
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS = '0';

    const { svc, delivery } = createAggregatorHarness({ 'guest-1': 'guest' });

    const meetingId = 'm-indecision-no-patterns';
    const now = 1_700_000_050_000;

    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'guest-1',
        timestamp: now,
        text: 'Obrigado, ficou claro. Vamos seguir.',
        analysis: {
          sales_category: 'value_exploration',
          sales_category_confidence: 0.9,
          sales_category_flags: {
            indecision_detected: false,
            decision_postponement_signal: false,
            conditional_language_signal: false,
          },
          sales_category_aggregated: {
            dominant_category: 'value_exploration',
            chunks_with_category: 10,
            total_chunks: 10,
            stability: 0.9,
            category_distribution: { value_exploration: 1.0 },
          },
          sales_category_trend: { trend: 'advancing', trend_strength: 0.8, current_stage: 3, velocity: 0.5 },
          indecision_metrics: {
            indecision_score: 0.0,
            postponement_likelihood: 0.0,
            conditional_language_score: 0.0,
          },
        },
      }),
    );

    const indecisionCount = delivery.published.filter(
      (p) => p.payload.type === 'sales_client_indecision',
    ).length;
    expect(indecisionCount).toBe(0);
  });

  test('does not publish sales_client_indecision when chunks_with_category is 0', () => {
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS = '0';

    const { svc, delivery } = createAggregatorHarness({ 'guest-1': 'guest' });

    const meetingId = 'm-indecision-2';
    const now = 1_700_000_100_000;

    const evt = makeTextAnalysisResult({
      meetingId,
      participantId: 'guest-1',
      timestamp: now,
      text: 'Talvez eu precise pensar melhor antes de decidir.',
      analysis: {
        sales_category: 'objection_soft',
        sales_category_confidence: 0.9,
        sales_category_flags: {
          indecision_detected: true,
          decision_postponement_signal: true,
          conditional_language_signal: true,
        },
        sales_category_aggregated: {
          dominant_category: 'stalling',
          chunks_with_category: 0,
          total_chunks: 0,
          stability: 0.0,
          category_distribution: { stalling: 0.0, objection_soft: 0.0 },
        },
      },
    });

    svc.handleTextAnalysis(evt);

    const indecisionCount = delivery.published.filter(
      (p) => p.payload.type === 'sales_client_indecision',
    ).length;
    expect(indecisionCount).toBe(0);
  });

  test('does not publish sales_client_indecision when confidence is below threshold (0.5)', () => {
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS = '0';

    const { svc, delivery } = createAggregatorHarness({ 'guest-1': 'guest' });

    const meetingId = 'm-indecision-low-confidence';
    const now = 1_700_000_150_000;

    // Has a pattern (conditional_language_signal) and enough data, but weak overall signal => confidence < 0.5.
    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'guest-1',
        timestamp: now,
        text: 'Talvez.',
        analysis: {
          sales_category: 'objection_soft',
          sales_category_confidence: 0.2,
          sales_category_ambiguity: 0.5,
          sales_category_flags: {
            indecision_detected: false,
            decision_postponement_signal: false,
            conditional_language_signal: true,
          },
          sales_category_aggregated: {
            dominant_category: 'objection_soft',
            chunks_with_category: 1,
            total_chunks: 1,
            stability: 0.4,
            category_distribution: { stalling: 0.0, objection_soft: 0.1 },
          },
          sales_category_trend: { trend: 'regressing', trend_strength: 0.0, current_stage: 1, velocity: 1.0 },
          indecision_metrics: {
            indecision_score: 0.0,
            postponement_likelihood: 0.0,
            conditional_language_score: 0.0,
          },
        },
      }),
    );

    const indecisionCount = delivery.published.filter(
      (p) => p.payload.type === 'sales_client_indecision',
    ).length;
    expect(indecisionCount).toBe(0);
  });

  test('respects cooldown when enabled', () => {
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS = '60000';

    const { svc, delivery } = createAggregatorHarness({ 'guest-1': 'guest' });

    const meetingId = 'm-indecision-3';
    const now = 1_700_000_200_000;

    const makeEvt = (ts: number) =>
      makeTextAnalysisResult({
        meetingId,
        participantId: 'guest-1',
        timestamp: ts,
        text: 'Talvez eu precise pensar e avaliar antes de decidir.',
        analysis: {
          sales_category: 'objection_soft',
          sales_category_confidence: 0.9,
          sales_category_intensity: 0.7,
          sales_category_ambiguity: 0.95,
          sales_category_flags: {
            indecision_detected: true,
            decision_postponement_signal: true,
            conditional_language_signal: true,
          },
          sales_category_aggregated: {
            dominant_category: 'stalling',
            chunks_with_category: 10,
            total_chunks: 10,
            stability: 0.8,
            category_distribution: { stalling: 0.7, objection_soft: 0.1 },
          },
          sales_category_trend: {
            trend: 'stable',
            trend_strength: 0.9,
            current_stage: 2,
            velocity: 0.05,
          },
          indecision_metrics: {
            indecision_score: 0.9,
            postponement_likelihood: 0.9,
            conditional_language_score: 0.9,
          },
        },
      });

    svc.handleTextAnalysis(makeEvt(now));
    svc.handleTextAnalysis(makeEvt(now + 1000));

    const indecisionCount = delivery.published.filter(
      (p) => p.payload.type === 'sales_client_indecision',
    ).length;
    expect(indecisionCount).toBe(1);
  });

  test('cooldown=0 ignores stale in-memory cooldown state (regression)', () => {
    const { svc, delivery } = createAggregatorHarness({ 'guest-1': 'guest' });

    const meetingId = 'm-indecision-cooldown-zero-regression';
    const now = 1_700_000_250_000;

    const evt = makeTextAnalysisResult({
      meetingId,
      participantId: 'guest-1',
      timestamp: now,
      text: 'Talvez eu precise pensar melhor e avaliar antes de decidir.',
      analysis: {
        sales_category: 'objection_soft',
        sales_category_confidence: 0.9,
        sales_category_intensity: 0.7,
        sales_category_ambiguity: 0.95,
        sales_category_flags: {
          indecision_detected: true,
          decision_postponement_signal: true,
          conditional_language_signal: true,
        },
        sales_category_aggregated: {
          dominant_category: 'stalling',
          chunks_with_category: 10,
          total_chunks: 10,
          stability: 0.8,
          category_distribution: { stalling: 0.7, objection_soft: 0.1 },
        },
        sales_category_trend: { trend: 'stable', trend_strength: 0.9, current_stage: 2, velocity: 0.05 },
        indecision_metrics: { indecision_score: 0.9, postponement_likelihood: 0.9, conditional_language_score: 0.9 },
      },
    });

    // First run with cooldown enabled → triggers and sets cooldown in memory.
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS = '60000';
    svc.handleTextAnalysis(evt);

    // Then disable cooldown via env and emit again within the old cooldown window.
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS = '0';
    svc.handleTextAnalysis({ ...evt, timestamp: now + 1000 });

    const indecisionCount = delivery.published.filter(
      (p) => p.payload.type === 'sales_client_indecision',
    ).length;
    expect(indecisionCount).toBe(2);
  });
});


