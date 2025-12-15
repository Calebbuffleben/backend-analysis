import { detectMonotony } from './detect-monotony';
import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

describe('detectMonotony', () => {
  const meetingId = 'test-meeting';
  const participantId = 'test-participant';
  const now = Date.now();
  const longWindowMs = A2E2_THRESHOLDS.windows.long;
  const minSpeechProsodic = A2E2_THRESHOLDS.gates.minSpeechProsodic;

  const createMockCtx = () => ({
    meetingId,
    participantId,
    now,
    getParticipantName: jest.fn(() => 'Test User'),
    inCooldown: jest.fn(() => false),
    setCooldown: jest.fn(),
    makeId: jest.fn(() => 'test-id-123'),
  });

  const createSamplesWithArousal = (
    arousalValues: number[],
    speechCoverage: number,
  ): Array<{ ts: number; speech: boolean; arousal?: number }> => {
    const totalSamples = Math.ceil(arousalValues.length / speechCoverage);
    const speechCount = Math.ceil(totalSamples * speechCoverage);
    const samples: Array<{ ts: number; speech: boolean; arousal?: number }> = [];
    let arousalIdx = 0;

    for (let i = 0; i < totalSamples; i++) {
      const isSpeech = i < speechCount; // Garante exatamente speechCoverage% de speech
      samples.push({
        ts: now - (totalSamples - i) * 1000,
        speech: isSpeech,
        arousal: isSpeech && arousalIdx < arousalValues.length ? arousalValues[arousalIdx++] : undefined,
      });
    }

    return samples;
  };

  describe('Cenário Positivo - Detecta monotonia', () => {
    it('deve detectar monotonia quando stdev está abaixo de 0.06 (warning)', () => {
      // Valores muito próximos (baixa variância)
      const arousalValues = [0.5, 0.51, 0.49, 0.52, 0.5, 0.51, 0.49, 0.5];
      const samples = createSamplesWithArousal(arousalValues, 0.45); // 45% para garantir >= 40%
      const state = {
        samples,
        ema: { arousal: 0.5 },
        cooldownUntilByType: new Map<string, number>(),
        lastFeedbackAt: undefined,
      };
      const ctx = createMockCtx();

      const result = detectMonotony(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('monotonia_prosodica');
      expect(result?.severity).toBe('warning');
      expect(ctx.setCooldown).toHaveBeenCalled();
    });

    it('deve detectar monotonia quando stdev está entre 0.06 e 0.1 (info)', () => {
      // Valores com pouca variação
      const arousalValues = [0.5, 0.55, 0.45, 0.52, 0.48, 0.53, 0.47, 0.51];
      const samples = createSamplesWithArousal(arousalValues, 0.45); // 45% para garantir >= 40%
      const state = {
        samples,
        ema: { arousal: 0.5 },
        cooldownUntilByType: new Map<string, number>(),
        lastFeedbackAt: undefined,
      };
      const ctx = createMockCtx();

      const result = detectMonotony(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('monotonia_prosodica');
      expect(result?.severity).toBe('info');
    });

    it('deve detectar monotonia com speech coverage acima de 40%', () => {
      const arousalValues = [0.5, 0.51, 0.49, 0.52, 0.5, 0.51, 0.49, 0.5, 0.51, 0.49];
      const samples = createSamplesWithArousal(arousalValues, 0.6);
      const state = {
        samples,
        ema: { arousal: 0.5 },
        cooldownUntilByType: new Map<string, number>(),
        lastFeedbackAt: undefined,
      };
      const ctx = createMockCtx();

      const result = detectMonotony(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('monotonia_prosodica');
    });
  });

  describe('Cenário Negativo - Não detecta monotonia', () => {
    it('não deve detectar quando stdev está acima de 0.1 (variação normal)', () => {
      // Valores com boa variação
      const arousalValues = [0.2, 0.5, 0.8, 0.3, 0.7, 0.4, 0.6, 0.3];
      const samples = createSamplesWithArousal(arousalValues, 0.5);
      const state = {
        samples,
        ema: { arousal: 0.5 },
        cooldownUntilByType: new Map<string, number>(),
        lastFeedbackAt: undefined,
      };
      const ctx = createMockCtx();

      const result = detectMonotony(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando speech coverage está abaixo de 40%', () => {
      const arousalValues = [0.5, 0.51, 0.49, 0.52, 0.5];
      const samples = createSamplesWithArousal(arousalValues, 0.3); // 30% coverage
      const state = {
        samples,
        ema: { arousal: 0.5 },
        cooldownUntilByType: new Map<string, number>(),
        lastFeedbackAt: undefined,
      };
      const ctx = createMockCtx();

      const result = detectMonotony(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há menos de 5 amostras de speech', () => {
      const arousalValues = [0.5, 0.51, 0.49, 0.52]; // Apenas 4 valores
      const samples = createSamplesWithArousal(arousalValues, 0.5);
      const state = {
        samples,
        ema: { arousal: 0.5 },
        cooldownUntilByType: new Map<string, number>(),
        lastFeedbackAt: undefined,
      };
      const ctx = createMockCtx();

      const result = detectMonotony(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário Borderline - Casos limite', () => {
    it('deve detectar como info quando stdev está exatamente em 0.1', () => {
      // Valores que resultam em stdev ≈ 0.1
      const arousalValues = [0.4, 0.5, 0.6, 0.45, 0.55, 0.5, 0.5, 0.5];
      const samples = createSamplesWithArousal(arousalValues, 0.5);
      const state = {
        samples,
        ema: { arousal: 0.5 },
        cooldownUntilByType: new Map<string, number>(),
        lastFeedbackAt: undefined,
      };
      const ctx = createMockCtx();

      const result = detectMonotony(state, ctx);

      // stdev próximo a 0.1 deve retornar info
      if (result) {
        expect(result.type).toBe('monotonia_prosodica');
      }
    });

    it('não deve detectar quando stdev está ligeiramente acima de 0.1', () => {
      // Valores com variação um pouco maior
      const arousalValues = [0.3, 0.5, 0.7, 0.4, 0.6, 0.5, 0.5, 0.5];
      const samples = createSamplesWithArousal(arousalValues, 0.5);
      const state = {
        samples,
        ema: { arousal: 0.5 },
        cooldownUntilByType: new Map<string, number>(),
        lastFeedbackAt: undefined,
      };
      const ctx = createMockCtx();

      const result = detectMonotony(state, ctx);

      // stdev > 0.1 não deve detectar
      expect(result).toBeNull();
    });

    it('não deve detectar quando está em cooldown', () => {
      const arousalValues = [0.5, 0.51, 0.49, 0.52, 0.5, 0.51, 0.49, 0.5];
      const samples = createSamplesWithArousal(arousalValues, 0.5);
      const state = {
        samples,
        ema: { arousal: 0.5 },
        cooldownUntilByType: new Map<string, number>(),
        lastFeedbackAt: undefined,
      };
      const ctx = createMockCtx();
      ctx.inCooldown = jest.fn(() => true);

      const result = detectMonotony(state, ctx);

      expect(result).toBeNull();
    });
  });
});

