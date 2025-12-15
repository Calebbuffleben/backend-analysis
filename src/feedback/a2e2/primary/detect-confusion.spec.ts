import { detectConfusion } from './detect-confusion';
import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

describe('detectConfusion', () => {
  const meetingId = 'test-meeting';
  const participantId = 'test-participant';
  const now = Date.now();
  const longWindowMs = A2E2_THRESHOLDS.windows.long;

  const createMockCtx = () => ({
    meetingId,
    participantId,
    now,
    getParticipantName: jest.fn(() => 'Test User'),
    inCooldown: jest.fn(() => false),
    inGlobalCooldown: jest.fn(() => false),
    setCooldown: jest.fn(),
    makeId: jest.fn(() => 'test-id-123'),
    window: jest.fn((state, n, ms) => ({
      start: n - ms,
      end: n,
      samplesCount: 10,
      speechCount: 8,
    })),
  });

  const createMockState = (emotions: Map<string, number>, valence = 0.0) => ({
    samples: Array.from({ length: 10 }, (_, i) => ({
      ts: now - (10 - i) * 1000,
      speech: true,
    })),
    ema: {
      emotions,
      valence,
      rms: -20,
    },
    cooldownUntilByType: new Map<string, number>(),
    lastFeedbackAt: undefined,
  });

  describe('Cenário Positivo - Detecta confusão', () => {
    it('deve detectar confusão quando doubt está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['doubt', 0.20], // Acima de 0.15 (threshold)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConfusion(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('confusao');
      expect(result?.message).toContain('dúvida detectada');
      expect(result?.tips).toContain('Explore a dúvida');
    });

    it('deve usar mensagem específica quando confusion é dominante', () => {
      const emotions = new Map<string, number>([
        ['confusion', 1.1], // Acima de 1 (threshold) e maior que doubt
        ['doubt', 0.10], // Abaixo de 0.15
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConfusion(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.message).toContain('confusão detectada');
    });

    it('deve usar mensagem específica quando doubt é dominante', () => {
      const emotions = new Map<string, number>([
        ['confusion', 0.5], // Abaixo de 1 (threshold), então não tem hasConfusion
        ['doubt', 0.20], // Acima de 0.15 (threshold) e maior que confusion
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConfusion(state, ctx);

      expect(result).not.toBeNull();
      // Quando doubt é maior e está acima do threshold, e confusion não está acima do threshold, usa mensagem específica de doubt
      expect(result?.message).toContain('dúvida detectada');
    });
  });

  describe('Cenário Negativo - Não detecta confusão', () => {
    it('não deve detectar quando confusion e doubt estão abaixo do threshold', () => {
      const emotions = new Map<string, number>([
        ['confusion', 0.5], // Abaixo de 1
        ['doubt', 0.10], // Abaixo de 0.15
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConfusion(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando valence está muito positivo', () => {
      const emotions = new Map<string, number>([
        ['doubt', 0.20],
      ]);
      const state = createMockState(emotions, 0.25); // Valence > 0.2
      const ctx = createMockCtx();

      const result = detectConfusion(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade muito alta (rage > 0.10) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['confusion', 0.10],
        ['rage', 0.11], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConfusion(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há medo muito alto (terror > 0.10) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['confusion', 0.10],
        ['terror', 0.11], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConfusion(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há frustração muito alta (frustration > 0.12) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['confusion', 0.10],
        ['frustration', 0.13], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConfusion(state, ctx);

      expect(result).toBeNull();
    });
  });
});

