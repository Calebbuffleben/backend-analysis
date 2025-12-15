import { detectSilence } from './detect-silence';
import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

describe('detectSilence', () => {
  const meetingId = 'test-meeting';
  const participantId = 'test-participant';
  const now = Date.now();
  const silenceWindowMs = A2E2_THRESHOLDS.longterm.silence.windowMs;
  const minSamples = A2E2_THRESHOLDS.longterm.silence.minSamples;

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
      const samplesInWindow = state.samples.filter((s: { ts: number }) => s.ts >= n - ms);
      const speechCount = samplesInWindow.filter((s: { speech: boolean }) => s.speech).length;
      const rmsValues = samplesInWindow
        .map((s: { rmsDbfs?: number }) => s.rmsDbfs)
        .filter((v: number | undefined): v is number => typeof v === 'number');
      const meanRms = rmsValues.length > 0
        ? rmsValues.reduce((a: number, b: number) => a + b, 0) / rmsValues.length
        : undefined;

      return {
        start: n - ms,
        end: n,
        samplesCount: samplesInWindow.length,
        speechCount,
        meanRmsDbfs: meanRms,
      };
    }),
  });

  const createMockState = (
    speechCoverage: number,
    rmsDbfs: number,
    hasSpokenBefore: boolean,
    arousal?: number,
  ) => {
    const samplesInWindow = Math.max(minSamples, 20);
    const speechCount = Math.floor(samplesInWindow * speechCoverage);

    const samples: Array<{ ts: number; speech: boolean; rmsDbfs?: number }> = [];

    // Adiciona amostras antigas (fora da janela) para simular "hasSpokenBefore"
    if (hasSpokenBefore) {
      samples.push({
        ts: now - silenceWindowMs - 10000,
        speech: true,
        rmsDbfs: -20,
      });
    }

    // Adiciona amostras na janela
    for (let i = 0; i < samplesInWindow; i++) {
      const isSpeech = i < speechCount;
      // Para testes que verificam RMS acima de threshold, usar o mesmo RMS para todos
      const sampleRms = isSpeech ? rmsDbfs : (rmsDbfs > -50 ? rmsDbfs : rmsDbfs - 10);
      samples.push({
        ts: now - (samplesInWindow - i) * 1000,
        speech: isSpeech,
        rmsDbfs: sampleRms,
      });
    }

    return {
      samples,
      ema: {
        arousal,
        rms: rmsDbfs,
      },
      cooldownUntilByType: new Map<string, number>(),
      lastFeedbackAt: undefined,
    };
  };

  describe('Cenário Positivo - Detecta silêncio prolongado', () => {
    it('deve detectar silêncio quando speech coverage < 5% e RMS <= -50 dBFS', () => {
      const state = createMockState(0.03, -55, true, 0.1); // 3% coverage, RMS baixo, arousal baixo
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('silencio_prolongado');
      expect(result?.severity).toBe('warning');
      expect(result?.message).toContain('sem áudio há 60s');
      expect(ctx.setCooldown).toHaveBeenCalled();
    });

    it('deve detectar silêncio quando speech coverage é 0%', () => {
      const state = createMockState(0.0, -55, true, 0.1);
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('silencio_prolongado');
    });

    it('deve detectar silêncio quando RMS está muito baixo (sem dados)', () => {
      const state = {
        ...createMockState(0.02, -55, true, 0.1),
        samples: createMockState(0.02, -55, true, 0.1).samples.map((s) => ({
          ...s,
          rmsDbfs: undefined,
        })),
      };
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('silencio_prolongado');
    });
  });

  describe('Cenário Negativo - Não detecta silêncio', () => {
    it('não deve detectar quando speech coverage >= 5%', () => {
      const state = createMockState(0.06, -55, true, 0.1); // 6% coverage
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando RMS está acima de -50 dBFS', () => {
      const state = createMockState(0.03, -49, true, 0.1); // RMS acima de -50 (não detecta)
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando participante nunca falou antes', () => {
      const state = createMockState(0.03, -55, false, 0.1); // Nunca falou
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando arousal está alto (pausa normal)', () => {
      const state = createMockState(0.03, -55, true, 0.6); // Arousal alto
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há menos de 10 amostras', () => {
      const state = {
        samples: Array.from({ length: 5 }, (_, i) => ({
          ts: now - (5 - i) * 1000,
          speech: false,
          rmsDbfs: -55,
        })),
        ema: { arousal: 0.1, rms: -55 },
        cooldownUntilByType: new Map<string, number>(),
        lastFeedbackAt: undefined,
      };
      // Adiciona amostra antiga para hasSpokenBefore
      state.samples.push({
        ts: now - silenceWindowMs - 10000,
        speech: true,
        rmsDbfs: -20,
      });
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário Borderline - Casos limite', () => {
    it('não deve detectar quando speech coverage está exatamente em 5%', () => {
      const state = createMockState(0.05, -55, true, 0.1); // Exatamente 5%
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      // Threshold é < 5%, então 5% não deve detectar
      expect(result).toBeNull();
    });

    it('deve detectar quando speech coverage está ligeiramente abaixo de 5% (4.9%)', () => {
      const state = createMockState(0.049, -55, true, 0.1); // 4.9%
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('silencio_prolongado');
    });

    it('deve detectar quando RMS está exatamente em -50 dBFS', () => {
      const state = createMockState(0.03, -50, true, 0.1); // RMS exato
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('silencio_prolongado');
    });

    it('não deve detectar quando RMS está ligeiramente acima de -50 dBFS (-49)', () => {
      const state = createMockState(0.03, -49, true, 0.1);
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando arousal está exatamente no threshold alto (0.5)', () => {
      const state = createMockState(0.03, -55, true, 0.5); // Arousal no threshold
      const ctx = createMockCtx();

      const result = detectSilence(state, ctx);

      // Arousal >= 0.5 não deve detectar
      expect(result).toBeNull();
    });

    it('não deve detectar quando está em cooldown', () => {
      const state = createMockState(0.03, -55, true, 0.1);
      const ctx = createMockCtx();
      ctx.inCooldown = jest.fn(() => true);

      const result = detectSilence(state, ctx);

      expect(result).toBeNull();
    });
  });
});

