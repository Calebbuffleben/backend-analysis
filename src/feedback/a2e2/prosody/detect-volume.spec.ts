import { detectVolume } from './detect-volume';
import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

describe('detectVolume', () => {
  const meetingId = 'test-meeting';
  const participantId = 'test-participant';
  const now = Date.now();
  const shortWindowMs = A2E2_THRESHOLDS.windows.short;
  const minSpeechProsodicVolume = A2E2_THRESHOLDS.gates.minSpeechProsodicVolume;

  const createMockCtx = () => ({
    meetingId,
    participantId,
    now,
    getParticipantName: jest.fn(() => 'Test User'),
    inCooldown: jest.fn(() => false),
    inGlobalCooldown: jest.fn(() => false),
    setCooldown: jest.fn(),
    makeId: jest.fn(() => 'test-id-123'),
    window: jest.fn((state, n, ms) => {
      const start = n - ms;
      const samplesInWindow = state.samples.filter((s: { ts: number }) => s.ts >= start);
      const speechCount = samplesInWindow.filter((s: { speech: boolean }) => s.speech).length;
      const rmsValues = samplesInWindow
        .map((s: { rmsDbfs?: number }) => s.rmsDbfs)
        .filter((v: number | undefined): v is number => typeof v === 'number');
      const meanRms = rmsValues.length > 0
        ? rmsValues.reduce((a: number, b: number) => a + b, 0) / rmsValues.length
        : undefined;

      // Se não há samples na janela, retorna valores mínimos para passar no gate
      if (samplesInWindow.length === 0) {
        return {
          start,
          end: n,
          samplesCount: 1,
          speechCount: 1, // Garante speech coverage alto
          meanRmsDbfs: state.ema.rms,
        };
      }

      return {
        start,
        end: n,
        samplesCount: samplesInWindow.length,
        speechCount,
        meanRmsDbfs: meanRms,
      };
    }),
  });

  const createMockState = (rmsDbfs: number, speechCoverage: number) => {
    // Volume usa janela curta (5s), então precisamos de samples nos últimos 5 segundos
    // E precisa de pelo menos 15 samples (threshold mínimo)
    const totalSamples = Math.max(15, Math.ceil(shortWindowMs / 200)); // 200ms entre samples
    const speechCount = Math.ceil(totalSamples * speechCoverage);
    const intervalMs = shortWindowMs / totalSamples;
    const samples = Array.from({ length: totalSamples }, (_, i) => ({
      ts: now - (totalSamples - i) * intervalMs,
      speech: i < speechCount, // Garante exatamente speechCoverage% de speech
      rmsDbfs,
    }));

    return {
      samples,
      ema: { rms: rmsDbfs },
      cooldownUntilByType: new Map<string, number>(),
      lastFeedbackAt: undefined,
    };
  };

  describe('Cenário Positivo - Detecta volume anormal', () => {
    it('deve detectar volume baixo crítico (<= -34 dBFS)', () => {
      const state = createMockState(-35, 0.6);
      const ctx = createMockCtx();

      const result = detectVolume(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('volume_baixo');
      expect(result?.severity).toBe('critical');
      expect(result?.message).toContain('quase inaudível');
      expect(ctx.setCooldown).toHaveBeenCalled();
    });

    it('deve detectar volume baixo warning (<= -28 dBFS)', () => {
      const state = createMockState(-30, 0.6);
      const ctx = createMockCtx();

      const result = detectVolume(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('volume_baixo');
      expect(result?.severity).toBe('warning');
      expect(result?.message).toContain('volume baixo');
    });

    it('deve detectar volume alto crítico (>= -6 dBFS)', () => {
      const state = createMockState(-5, 0.6);
      const ctx = createMockCtx();

      const result = detectVolume(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('volume_alto');
      expect(result?.severity).toBe('critical');
      expect(result?.message).toContain('clipando');
    });

    it('deve detectar volume alto warning (>= -10 dBFS)', () => {
      const state = createMockState(-8, 0.6);
      const ctx = createMockCtx();

      const result = detectVolume(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('volume_alto');
      expect(result?.severity).toBe('warning');
      expect(result?.message).toContain('volume alto');
    });
  });

  describe('Cenário Negativo - Não detecta volume anormal', () => {
    it('não deve detectar quando volume está normal (-20 dBFS)', () => {
      const state = createMockState(-20, 0.6);
      const ctx = createMockCtx();

      const result = detectVolume(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando speech coverage está abaixo de 50%', () => {
      const state = createMockState(-30, 0.4); // 40% coverage
      const ctx = createMockCtx();

      const result = detectVolume(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando não há dados de RMS', () => {
      const state = {
        samples: Array.from({ length: 10 }, (_, i) => ({
          ts: now - (10 - i) * 1000,
          speech: true,
          rmsDbfs: undefined,
        })),
        ema: { rms: undefined },
        cooldownUntilByType: new Map<string, number>(),
        lastFeedbackAt: undefined,
      };
      const ctx = createMockCtx();

      const result = detectVolume(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando está em cooldown', () => {
      const state = createMockState(-30, 0.6);
      const ctx = createMockCtx();
      ctx.inCooldown = jest.fn(() => true);

      const result = detectVolume(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário Borderline - Casos limite', () => {
    it('deve detectar volume baixo quando está exatamente em -28 dBFS', () => {
      const state = createMockState(-28, 0.6);
      const ctx = createMockCtx();

      const result = detectVolume(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('volume_baixo');
      expect(result?.severity).toBe('warning'); // Não é critical ainda
    });

    it('não deve detectar quando está ligeiramente acima de -28 dBFS (-27.9)', () => {
      const state = createMockState(-27.9, 0.6);
      const ctx = createMockCtx();

      const result = detectVolume(state, ctx);

      expect(result).toBeNull();
    });

    it('deve detectar volume alto quando está exatamente em -10 dBFS', () => {
      const state = createMockState(-10, 0.6);
      const ctx = createMockCtx();

      const result = detectVolume(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('volume_alto');
      expect(result?.severity).toBe('warning'); // Não é critical ainda
    });

    it('não deve detectar quando está ligeiramente abaixo de -10 dBFS (-10.1)', () => {
      const state = createMockState(-10.1, 0.6);
      const ctx = createMockCtx();

      const result = detectVolume(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando está em global cooldown', () => {
      const state = createMockState(-30, 0.6);
      const ctx = createMockCtx();
      ctx.inGlobalCooldown = jest.fn(() => true);

      const result = detectVolume(state, ctx);

      expect(result).toBeNull();
    });
  });
});

