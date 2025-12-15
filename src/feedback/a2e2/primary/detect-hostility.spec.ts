import { detectHostility } from './detect-hostility';
import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

describe('detectHostility', () => {
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

  const createMockState = (
    emotions: Map<string, number>,
    valence = 0.1,
    arousal = 0.4, // Arousal alto para passar na verificação contextual (>= 0.3)
  ) => ({
    samples: Array.from({ length: 10 }, (_, i) => ({
      ts: now - (10 - i) * 1000,
      speech: true,
    })),
    ema: {
      emotions,
      valence,
      arousal,
      rms: -20,
    },
    cooldownUntilByType: new Map<string, number>(),
    lastFeedbackAt: undefined,
  });

  describe('Cenário Positivo - Detecta hostilidade ativa', () => {
    it('deve detectar hostilidade quando anger está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.10], // Acima de 0.07
        ['disgust', 0.02],
        ['distress', 0.01],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
      expect(result?.severity).toBe('warning'); // Arousal >= 0.3
      expect(ctx.setCooldown).toHaveBeenCalled();
    });

    it('deve detectar hostilidade quando disgust está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.02],
        ['disgust', 0.10], // Acima de 0.07
        ['distress', 0.01],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
    });

    it('deve detectar hostilidade quando distress está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.02],
        ['disgust', 0.01],
        ['distress', 0.10], // Acima de 0.07
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
    });

    it('deve detectar hostilidade quando rage está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['rage', 0.10], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
      expect(result?.severity).toBe('warning'); // Rage sempre warning
    });

    it('deve detectar hostilidade quando contempt está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['contempt', 0.10], // Acima de 0.07
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
    });
  });

  describe('Cenário Positivo - Detecta medo/ameaça', () => {
    it('deve detectar hostilidade quando fear está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['fear', 0.12], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
      expect(result?.severity).toBe('warning'); // Fear > 0.10 = warning
    });

    it('deve detectar hostilidade quando horror está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['horror', 0.15], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
      expect(result?.severity).toBe('warning'); // Horror sempre warning
    });

    it('deve detectar hostilidade quando terror está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['terror', 0.15], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
      expect(result?.severity).toBe('warning'); // Terror sempre warning
    });

    it('deve detectar hostilidade quando anxiety está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['anxiety', 0.10], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
      expect(result?.severity).toBe('warning'); // Anxiety > 0.10 = warning
    });

    it('deve detectar anxiety com severity info quando <= 0.10', () => {
      const emotions = new Map<string, number>([
        ['anxiety', 0.09], // Acima de 0.08 mas <= 0.10
      ]);
      const state = createMockState(emotions, -0.1, 0.25); // Arousal < 0.3
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
      expect(result?.severity).toBe('info'); // Anxiety <= 0.10 = info
    });
  });

  describe('Cenário Negativo - Não detecta hostilidade', () => {
    it('não deve detectar quando todas as emoções estão abaixo do threshold', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.05], // Abaixo de 0.07
        ['disgust', 0.05],
        ['distress', 0.05],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar hostilidade ativa quando arousal está muito baixo', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.10], // Acima do threshold
      ]);
      const state = createMockState(emotions, -0.1, 0.15); // Arousal < 0.2
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar medo quando arousal está muito baixo', () => {
      const emotions = new Map<string, number>([
        ['fear', 0.12], // Acima do threshold
      ]);
      const state = createMockState(emotions, -0.1, 0.10); // Arousal < 0.15
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar hostilidade ativa quando valence está muito positivo', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.10], // Acima do threshold
      ]);
      const state = createMockState(emotions, 0.2, 0.3); // Valence > 0.1
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando não há emoções de hostilidade', () => {
      const emotions = new Map<string, number>([
        ['joy', 0.1],
        ['interest', 0.15],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando está em cooldown', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.15],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();
      ctx.inCooldown = jest.fn(() => true);

      const result = detectHostility(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário Borderline - Casos limite', () => {
    it('não deve detectar quando anger está exatamente no threshold (0.07)', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.07], // Exatamente no threshold
        ['disgust', 0.02],
        ['distress', 0.01],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      // Threshold é > 0.07, então 0.07 não deve detectar
      expect(result).toBeNull();
    });

    it('deve detectar quando anger está ligeiramente acima do threshold (0.0701)', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.0701], // Ligeiramente acima de 0.07
        ['disgust', 0.02],
        ['distress', 0.01],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
    });

    it('não deve detectar quando fear está exatamente no threshold (0.10)', () => {
      const emotions = new Map<string, number>([
        ['fear', 0.10], // Exatamente no threshold
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      // Threshold é > 0.10, então 0.10 não deve detectar
      expect(result).toBeNull();
    });

    it('deve detectar quando fear está ligeiramente acima do threshold (0.1001)', () => {
      const emotions = new Map<string, number>([
        ['fear', 0.1001], // Ligeiramente acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
    });

    it('não deve detectar quando está em global cooldown', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.15],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();
      ctx.inGlobalCooldown = jest.fn(() => true);

      const result = detectHostility(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário FASE 10.3.1 - Thresholds dinâmicos e bloqueio por oscilação rápida', () => {
    it('deve usar threshold reduzido em alta tensão (arousal > 0.5 && valence < 0.0)', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.057], // Threshold base = 0.07, reduzido 20% = 0.056, então 0.057 > 0.056 (alta tensão)
      ]);
      const state = createMockState(emotions, -0.1, 0.6); // Alta tensão: valence negativo, arousal alto
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
    });

    it('não deve detectar com threshold base quando não há alta tensão', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.056], // Abaixo do threshold base 0.07
      ]);
      const state = createMockState(emotions, 0.3, 0.1); // Tensão moderada
      const ctx = createMockCtx();

      const result = detectHostility(state, ctx);

      expect(result).toBeNull();
    });

    it('deve bloquear por oscilação rápida (3+ detecções nos últimos 30s)', () => {
      const emotions = new Map<string, number>([
        ['rage', 0.10], // Acima do threshold
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();
      
      // Simula histórico de 3 detecções recentes
      const mockGetRecentEmotions = jest.fn(() => [
        { type: 'hostilidade', ts: Date.now() - 10000 },
        { type: 'hostilidade', ts: Date.now() - 20000 },
        { type: 'hostilidade', ts: Date.now() - 25000 },
      ]);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectHostility(state, ctx);

      // Deve bloquear por oscilação rápida
      expect(result).toBeNull();
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });

    it('deve bloquear por sobreposição recente quando score atual não é > 20% maior', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.10], // Acima do threshold
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();
      
      // Simula histórico com emoção similar recente (score = 0.09)
      // Score atual (0.10) não é > 20% maior que 0.09 (0.09 * 1.2 = 0.108)
      const mockGetRecentEmotions = jest.fn(() => [
        { type: 'hostilidade', ts: Date.now() - 10000, score: 0.09 }, // 10s atrás
      ]);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectHostility(state, ctx);

      // Deve bloquear por sobreposição recente
      expect(result).toBeNull();
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });
  });

  describe('Cenário FASE 10.3.2 - Thresholds dinâmicos por padrão temporal', () => {
    it('deve usar threshold reduzido quando há tendência crescente (emoção aumentou > 0.02 nos últimos 10s)', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.060], // Threshold base = 0.07, reduzido 20% (tensão) = 0.056, reduzido 15% (tendência) = 0.0476, então 0.060 > 0.0476
      ]);
      const state = createMockState(emotions, -0.1, 0.6); // Alta tensão: arousal >= 0.2 (passa validação), valence <= 0.1 (passa validação)
      const ctx = createMockCtx();
      
      // Simula histórico com tendência crescente (para fallback de calculateEmotionTrend)
      const mockGetRecentEmotions = jest.fn((state, windowMs, now) => {
        if (windowMs === 10_000) {
          // Para cálculo de tendência (janela de 10s)
          return [
            { type: 'hostilidade', ts: now - 8000, score: 0.05 }, // Mais antigo
            { type: 'hostilidade', ts: now - 2000, score: 0.07 }, // Mais recente (aumentou > 0.02)
          ];
        }
        // Para outras validações (janela de 30s)
        return [];
      });
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;
      (ctx as any).getEmotionTrend = jest.fn(() => 'increasing');

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
      // getRecentEmotions é chamado dentro de getEmotionTrendValue (fallback) e depois para validações
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });

    it('deve usar threshold aumentado quando há tendência decrescente (emoção diminuiu > 0.02 nos últimos 10s)', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.07], // Threshold base = 0.07, aumentado 10% (tendência) = 0.077, então 0.07 < 0.077 (não detecta)
      ]);
      const state = createMockState(emotions, -0.05, 0.3); // Tensão moderada (não alta, para não reduzir threshold), mas arousal >= 0.2 (passa validação)
      const ctx = createMockCtx();
      
      // Simula histórico com tendência decrescente
      const mockGetRecentEmotions = jest.fn(() => [
        { type: 'hostilidade', ts: Date.now() - 8000, score: 0.10 }, // Mais antigo (maior)
        { type: 'hostilidade', ts: Date.now() - 2000, score: 0.07 }, // Mais recente (diminuiu > 0.02)
      ]);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;
      (ctx as any).getEmotionTrend = jest.fn(() => 'decreasing');

      const result = detectHostility(state, ctx);

      // Com threshold aumentado, 0.07 não passa
      expect(result).toBeNull();
      // getRecentEmotions é chamado dentro de getEmotionTrendValue, que é chamado antes das validações
      // Mas se a detecção falhar antes, pode não ser chamado. Vamos verificar se getEmotionTrend foi chamado
      expect((ctx as any).getEmotionTrend).toHaveBeenCalled();
    });

    it('deve reduzir threshold adicional quando há tendência consistente (3+ detecções consecutivas)', () => {
      const emotions = new Map<string, number>([
        ['anger', 0.052], // Threshold base = 0.07, reduzido 20% (tensão) = 0.056, reduzido mais 10% (tendência) = 0.0504, então 0.052 > 0.0504
      ]);
      const state = createMockState(emotions, -0.1, 0.6); // Alta tensão: arousal >= 0.2 (passa validação), valence <= 0.1 (passa validação)
      const ctx = createMockCtx();
      
      // Simula histórico com 3+ detecções consecutivas (gaps < 15s)
      const mockGetRecentEmotions = jest.fn((state, windowMs, now) => {
        if (windowMs === 30_000) {
          // Para validação de tendência consistente (janela de 30s)
          return [
            { type: 'hostilidade', ts: now - 10000 }, // 10s atrás
            { type: 'hostilidade', ts: now - 5000 }, // 5s atrás (gap de 5s < 15s)
            { type: 'hostilidade', ts: now - 2000 }, // 2s atrás (gap de 3s < 15s)
          ];
        }
        // Para cálculo de tendência (janela de 10s) - retorna vazio para usar fallback
        return [];
      });
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectHostility(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('hostilidade');
      // getRecentEmotions é chamado dentro de getEmotionTrendValue (fallback) e depois para validações
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });
  });
});

