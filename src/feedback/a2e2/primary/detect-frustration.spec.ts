import { detectFrustration } from './detect-frustration';
import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

describe('detectFrustration', () => {
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

  const createMockState = (emotions: Map<string, number>) => ({
    samples: Array.from({ length: 10 }, (_, i) => ({
      ts: now - (10 - i) * 1000,
      speech: true,
    })),
    ema: {
      emotions,
      valence: -0.1,
      arousal: 0.3,
      rms: -20,
    },
    cooldownUntilByType: new Map<string, number>(),
    lastFeedbackAt: undefined,
  });

  describe('Cenário Positivo - Detecta frustração', () => {
    it('deve detectar frustração quando frustration está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['frustration', 0.16], // Acima de 0.15 (threshold atual)
        ['anger', 0.02],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectFrustration(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('frustracao_crescente');
      expect(result?.severity).toBe('warning');
      expect(ctx.setCooldown).toHaveBeenCalled();
    });

    it('deve detectar frustração quando frustration está bem acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['frustration', 0.20], // Bem acima de 0.15
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectFrustration(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('frustracao_crescente');
    });

    it('deve detectar frustração mesmo com outras emoções presentes', () => {
      const emotions = new Map<string, number>([
        ['frustration', 0.16], // Acima de 0.15
        ['confusion', 0.03],
        ['interest', 0.02],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectFrustration(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('frustracao_crescente');
    });
  });

  describe('Cenário Negativo - Não detecta frustração', () => {
    it('não deve detectar quando frustration está abaixo do threshold', () => {
      const emotions = new Map<string, number>([
        ['frustration', 0.10], // Abaixo de 0.15
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectFrustration(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando não há emoção de frustração', () => {
      const emotions = new Map<string, number>([
        ['joy', 0.1],
        ['interest', 0.15],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectFrustration(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando está em cooldown', () => {
      const emotions = new Map<string, number>([
        ['frustration', 0.16],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();
      ctx.inCooldown = jest.fn(() => true);

      const result = detectFrustration(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário Borderline - Casos limite', () => {
    it('não deve detectar quando frustration está exatamente no threshold (0.15)', () => {
      const emotions = new Map<string, number>([
        ['frustration', 0.15], // Exatamente no threshold
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectFrustration(state, ctx);

      // Threshold é > 0.15, então 0.15 não deve detectar (usa <=)
      expect(result).toBeNull();
    });

    it('deve detectar quando frustration está ligeiramente acima do threshold (0.1501)', () => {
      const emotions = new Map<string, number>([
        ['frustration', 0.1501], // Ligeiramente acima de 0.15
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectFrustration(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('frustracao_crescente');
    });

    it('não deve detectar quando está em global cooldown', () => {
      const emotions = new Map<string, number>([
        ['frustration', 0.16],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();
      ctx.inGlobalCooldown = jest.fn(() => true);

      const result = detectFrustration(state, ctx);

      expect(result).toBeNull();
    });
  });
});

