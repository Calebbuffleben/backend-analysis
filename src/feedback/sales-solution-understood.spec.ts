import { createAggregatorHarness, makeTextAnalysisResult } from './test-utils/sales-detector-harness';

describe('sales_solution_understood (contract)', () => {
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
    // Ensure indecision cooldown doesn't affect these tests (indecision detector always runs).
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS = '0';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('publishes sales_solution_understood when guest reformulates a recent host explanation', () => {
    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });

    const meetingId = 'meeting-solution-1';
    const now = 1_700_000_300_000;

    const hostEvt = makeTextAnalysisResult({
      meetingId,
      participantId: 'host-1',
      timestamp: now,
      text: 'Funciona assim: a gente integra X, automatiza Y e você reduz Z na prática.',
      embedding: [1, 0],
      analysis: {
        keywords: ['integra', 'automatiza', 'reduz'],
        sales_category: 'value_exploration',
        speech_act: 'statement',
      },
    });

    const guestEvt = makeTextAnalysisResult({
      meetingId,
      participantId: 'guest-1',
      timestamp: now + 1000,
      text: 'Ou seja, se eu entendi, então vocês integram e automatizam pra reduzir o trabalho.',
      embedding: [0.99, 0.01],
      analysis: {
        keywords: ['integra', 'automatiza', 'reduz'],
        sales_category: 'information_gathering',
        speech_act: 'confirmation',
      },
    });

    svc.handleTextAnalysis(hostEvt);
    svc.handleTextAnalysis(guestEvt);

    const solutionEvents = delivery.published
      .map((p) => p.payload)
      .filter((p) => p.type === 'sales_solution_understood');

    expect(solutionEvents).toHaveLength(1);
    expect(solutionEvents[0].meetingId).toBe(meetingId);
    expect(solutionEvents[0].participantId).toBe('guest-1');
    expect(solutionEvents[0].severity).toBe('info');
    expect((solutionEvents[0].metadata?.markers_detected ?? []).length).toBeGreaterThan(0);
  });

  test('does not publish sales_solution_understood without any prior host context', () => {
    const { svc, delivery } = createAggregatorHarness({ 'guest-1': 'guest' });

    const meetingId = 'meeting-solution-no-context';
    const now = 1_700_000_350_000;

    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'guest-1',
        timestamp: now,
        text: 'Ou seja, se eu entendi, então vocês integram e automatizam pra reduzir o trabalho.',
        embedding: [1, 0],
        analysis: {
          keywords: ['integra', 'automatiza', 'reduz'],
          sales_category: 'information_gathering',
          speech_act: 'confirmation',
        },
      }),
    );

    const triggered = delivery.published.some((p) => p.payload.type === 'sales_solution_understood');
    expect(triggered).toBe(false);
  });

  test('does not publish sales_solution_understood without reformulation markers', () => {
    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });

    const meetingId = 'meeting-solution-2';
    const now = 1_700_000_400_000;

    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'host-1',
        timestamp: now,
        text: 'Funciona assim: a solução integra X e automatiza Y. Na prática você reduz Z.',
        embedding: [1, 0],
        analysis: {
          keywords: ['integra', 'automatiza', 'reduz'],
          sales_category: 'value_exploration',
          speech_act: 'statement',
        },
      }),
    );

    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'guest-1',
        timestamp: now + 1000,
        text: 'Vocês integram e automatizam para reduzir o trabalho, certo?',
        embedding: [0.99, 0.01],
        analysis: {
          keywords: ['integra', 'automatiza', 'reduz'],
          sales_category: 'information_gathering',
          speech_act: 'confirmation',
        },
      }),
    );

    const triggered = delivery.published.some((p) => p.payload.type === 'sales_solution_understood');
    expect(triggered).toBe(false);
  });

  test('does not publish sales_solution_understood for host turn (even with markers)', () => {
    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host' });

    const meetingId = 'meeting-solution-host-skip';
    const now = 1_700_000_450_000;

    // Host speaks with markers (should be ignored by detector)
    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'host-1',
        timestamp: now,
        text: 'Ou seja, deixa eu ver se entendi: eu explico e o cliente confirma.',
        embedding: [1, 0],
        analysis: {
          keywords: ['explico', 'cliente', 'confirma'],
          sales_category: 'value_exploration',
          speech_act: 'statement',
        },
      }),
    );

    const triggered = delivery.published.some((p) => p.payload.type === 'sales_solution_understood');
    expect(triggered).toBe(false);
  });

  test('does not publish sales_solution_understood when semantic similarity is too low', () => {
    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });

    const meetingId = 'meeting-solution-low-sim';
    const now = 1_700_000_460_000;

    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'host-1',
        timestamp: now,
        text: 'Funciona assim: a gente integra X e automatiza Y; você consegue reduzir Z.',
        embedding: [1, 0],
        analysis: {
          keywords: ['integra', 'automatiza', 'reduz'],
          sales_category: 'value_exploration',
          speech_act: 'statement',
        },
      }),
    );

    // Orthogonal embedding => similarity ~0
    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'guest-1',
        timestamp: now + 1000,
        text: 'Ou seja, se eu entendi, então vocês fazem algo totalmente diferente.',
        embedding: [0, 1],
        analysis: {
          keywords: ['diferente'],
          sales_category: 'information_gathering',
          speech_act: 'confirmation',
        },
      }),
    );

    const triggered = delivery.published.some((p) => p.payload.type === 'sales_solution_understood');
    expect(triggered).toBe(false);
  });

  test('blocks when keyword overlap is zero and similarityRaw is below 0.72', () => {
    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });

    const meetingId = 'meeting-solution-zero-overlap-block';
    const now = 1_700_000_470_000;

    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'host-1',
        timestamp: now,
        text: 'Funciona assim: a gente integra X e automatiza Y; você consegue reduzir Z.',
        embedding: [1, 0],
        analysis: {
          keywords: ['integra', 'automatiza', 'reduz'],
          sales_category: 'value_exploration',
          speech_act: 'statement',
        },
      }),
    );

    // similarityRaw ~= 0.71 (passes 0.6 gate, but should fail mitigation gate when overlap=0)
    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'guest-1',
        timestamp: now + 1000,
        text: 'Ou seja, se eu entendi, então vocês fazem um processo parecido.',
        embedding: [0.71, 0.704],
        analysis: {
          keywords: ['parecido'], // no overlap with host keywords
          sales_category: 'information_gathering',
          speech_act: 'confirmation',
        },
      }),
    );

    const triggered = delivery.published.some((p) => p.payload.type === 'sales_solution_understood');
    expect(triggered).toBe(false);
  });

  test('respects threshold from env (can block even when gates pass)', () => {
    process.env.SALES_SOLUTION_UNDERSTOOD_THRESHOLD = '0.9';

    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });

    const meetingId = 'meeting-solution-threshold-block';
    const now = 1_700_000_480_000;

    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'host-1',
        timestamp: now,
        text: 'Funciona assim: a gente integra X, automatiza Y e você reduz Z na prática.',
        embedding: [1, 0],
        analysis: {
          keywords: ['integra', 'automatiza', 'reduz'],
          sales_category: 'value_exploration',
          speech_act: 'statement',
        },
      }),
    );

    // Single marker + zero overlap (but similarity is high enough to bypass overlap mitigation).
    // This should typically produce a confidence below 0.9 → blocked by threshold.
    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'guest-1',
        timestamp: now + 1000,
        text: 'Ou seja, vocês conseguem ajudar no meu caso, certo?',
        embedding: [0.99, 0.01],
        analysis: {
          keywords: ['ajudar'], // no overlap with host keywords
          sales_category: 'information_gathering',
          speech_act: 'ask_info', // weaker than confirmation/agreement
        },
      }),
    );

    const triggered = delivery.published.some((p) => p.payload.type === 'sales_solution_understood');
    expect(triggered).toBe(false);
  });

  test('does not publish when context is older than SALES_SOLUTION_CONTEXT_WINDOW_MS', () => {
    process.env.SALES_SOLUTION_CONTEXT_WINDOW_MS = '10000';

    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });

    const meetingId = 'meeting-solution-window-expired';
    const now = 1_700_000_490_000;

    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'host-1',
        timestamp: now,
        text: 'Funciona assim: a gente integra X e automatiza Y; você consegue reduzir Z.',
        embedding: [1, 0],
        analysis: {
          keywords: ['integra', 'automatiza', 'reduz'],
          sales_category: 'value_exploration',
          speech_act: 'statement',
        },
      }),
    );

    // After 11s, the 10s window no longer includes the host context
    svc.handleTextAnalysis(
      makeTextAnalysisResult({
        meetingId,
        participantId: 'guest-1',
        timestamp: now + 11_000,
        text: 'Ou seja, se eu entendi, então vocês integram e automatizam pra reduzir o trabalho.',
        embedding: [0.99, 0.01],
        analysis: {
          keywords: ['integra', 'automatiza', 'reduz'],
          sales_category: 'information_gathering',
          speech_act: 'confirmation',
        },
      }),
    );

    const triggered = delivery.published.some((p) => p.payload.type === 'sales_solution_understood');
    expect(triggered).toBe(false);
  });

  test('respects cooldown when enabled', () => {
    process.env.SALES_SOLUTION_UNDERSTOOD_COOLDOWN_MS = '60000';

    const { svc, delivery } = createAggregatorHarness({ 'host-1': 'host', 'guest-1': 'guest' });

    const meetingId = 'meeting-solution-3';
    const now = 1_700_000_500_000;

    const hostEvt = makeTextAnalysisResult({
      meetingId,
      participantId: 'host-1',
      timestamp: now,
      text: 'Funciona assim: a gente integra X e automatiza Y; você consegue reduzir Z.',
      embedding: [1, 0],
      analysis: {
        keywords: ['integra', 'automatiza', 'reduz'],
        sales_category: 'value_exploration',
        speech_act: 'statement',
      },
    });

    const makeGuestEvt = (ts: number) =>
      makeTextAnalysisResult({
        meetingId,
        participantId: 'guest-1',
        timestamp: ts,
        text: 'Ou seja, se eu entendi, então vocês integram e automatizam pra reduzir o trabalho.',
        embedding: [0.99, 0.01],
        analysis: {
          keywords: ['integra', 'automatiza', 'reduz'],
          sales_category: 'information_gathering',
          speech_act: 'confirmation',
        },
      });

    svc.handleTextAnalysis(hostEvt);
    svc.handleTextAnalysis(makeGuestEvt(now + 1000));
    svc.handleTextAnalysis(makeGuestEvt(now + 2000));

    const count = delivery.published.filter((p) => p.payload.type === 'sales_solution_understood')
      .length;
    expect(count).toBe(1);
  });
});

