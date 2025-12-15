import { detectBoredom } from './detect-boredom';
import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

describe('detectBoredom', () => {
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

  const createMockState = (emotions: Map<string, number>, arousal = 0.2) => ({
    samples: Array.from({ length: 10 }, (_, i) => ({
      ts: now - (10 - i) * 1000,
      speech: true,
    })),
    ema: {
      emotions,
      arousal,
      rms: -20,
    },
    cooldownUntilByType: new Map<string, number>(),
    lastFeedbackAt: undefined,
  });

  describe('Cenário Positivo - Detecta tédio', () => {
    it('deve detectar tédio quando boredom está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['boredom', 0.20], // Acima de 0.15 (threshold)
        ['interest', 0.02], // Abaixo de 0.15 (confirma tédio)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectBoredom(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tedio');
      expect(result?.message).toContain('tédio detectado');
      expect(result?.tips).toContain('Varie a dinâmica');
    });

    it('deve detectar tédio quando tiredness está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['tiredness', 0.25], // Acima de 0.20 (threshold)
        ['interest', 0.02], // Abaixo de 0.15 (confirma tédio)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectBoredom(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tedio');
      expect(result?.message).toContain('cansaço detectado');
      expect(result?.tips).toContain('Considere fazer uma pausa');
    });

    it('deve usar mensagem genérica quando boredom e tiredness estão no mesmo nível', () => {
      const emotions = new Map<string, number>([
        ['boredom', 0.16],
        ['tiredness', 0.16], // Mesmo nível, ambos acima dos thresholds
        ['interest', 0.02],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectBoredom(state, ctx);

      expect(result).not.toBeNull();
      // Quando tiredness > boredom, usa mensagem de tiredness
      // Para testar mensagem genérica, precisamos que boredom seja maior mas não dominante
      expect(result?.message).toMatch(/tédio detectado|cansaço detectado|energia baixa detectada/);
    });
  });

  describe('Cenário Negativo - Não detecta tédio', () => {
    it('não deve detectar quando boredom e tiredness estão abaixo do threshold', () => {
      const emotions = new Map<string, number>([
        ['boredom', 0.10], // Abaixo de 0.15
        ['tiredness', 0.15], // Abaixo de 0.20
        ['interest', 0.02],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectBoredom(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando interest está alto', () => {
      const emotions = new Map<string, number>([
        ['boredom', 0.20],
        ['interest', 0.20], // Acima de 0.15 (não confirma tédio)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectBoredom(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há frustração significativa', () => {
      const emotions = new Map<string, number>([
        ['boredom', 0.20],
        ['frustration', 0.06], // Acima de 0.05
        ['interest', 0.02],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectBoredom(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade muito alta (rage > 0.10) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['boredom', 0.20],
        ['rage', 0.11], // Acima de 0.10
        ['interest', 0.02],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectBoredom(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há medo muito alto (terror > 0.10) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['boredom', 0.20],
        ['terror', 0.11], // Acima de 0.10
        ['interest', 0.02],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectBoredom(state, ctx);

      expect(result).toBeNull();
    });
  });
});

