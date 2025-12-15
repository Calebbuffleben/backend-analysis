import { detectSadness } from './detect-sadness';
import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

describe('detectSadness', () => {
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

  const createMockState = (emotions: Map<string, number>, valence = -0.1, arousal = 0.2) => ({
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

  describe('Cenário Positivo - Detecta tristeza', () => {
    it('deve detectar tristeza quando sadness está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['sadness', 0.12], // Acima de 0.10
        ['disappointment', 0.02],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
      expect(ctx.setCooldown).toHaveBeenCalled();
    });

    it('deve detectar tristeza quando disappointment está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['disappointment', 0.12], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
    });

    it('deve detectar tristeza quando guilt está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['guilt', 0.15], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
      expect(result?.severity).toBe('warning'); // Guilt > 0.15 = warning
    });

    it('deve detectar tristeza quando shame está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['shame', 0.15], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
      expect(result?.severity).toBe('warning'); // Shame > 0.15 = warning
    });

    it('deve detectar tristeza quando embarrassment está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['embarrassment', 0.15], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
    });

    it('deve detectar tristeza quando disapproval está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['disapproval', 0.10], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
    });
  });

  describe('Cenário Negativo - Não detecta tristeza', () => {
    it('não deve detectar quando todas as emoções estão abaixo do threshold', () => {
      const emotions = new Map<string, number>([
        ['sadness', 0.08], // Abaixo de 0.10
        ['disappointment', 0.05],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando valence está muito positivo', () => {
      const emotions = new Map<string, number>([
        ['sadness', 0.12],
      ]);
      const state = createMockState(emotions, 0.2); // Valence muito positivo (> 0.1)
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade extrema (rage)', () => {
      const emotions = new Map<string, number>([
        ['sadness', 0.12],
        ['rage', 0.12], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade extrema (contempt)', () => {
      const emotions = new Map<string, number>([
        ['sadness', 0.12],
        ['contempt', 0.12], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando está em cooldown', () => {
      const emotions = new Map<string, number>([
        ['sadness', 0.12],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();
      ctx.inCooldown = jest.fn(() => true);

      const result = detectSadness(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há frustração muito alta', () => {
      const emotions = new Map<string, number>([
        ['sadness', 0.12],
        ['frustration', 0.16], // Acima de 0.15
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há medo extremo (terror)', () => {
      const emotions = new Map<string, number>([
        ['sadness', 0.12],
        ['terror', 0.12], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário FASE 4 - Mensagens específicas por emoção', () => {
    it('deve gerar mensagem específica para shame', () => {
      const emotions = new Map<string, number>([
        ['shame', 0.15], // Acima de 0.12 e dominante
        ['guilt', 0.05],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.message).toContain('vergonha detectada');
      expect(result?.tips).toContain('Crie um espaço seguro');
    });

    it('deve gerar mensagem específica para guilt', () => {
      const emotions = new Map<string, number>([
        ['guilt', 0.15], // Acima de 0.12 e dominante
        ['shame', 0.05],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.message).toContain('culpa detectada');
      expect(result?.tips).toContain('Valide o sentimento');
    });

    it('deve gerar mensagem específica para embarrassment', () => {
      const emotions = new Map<string, number>([
        ['embarrassment', 0.15], // Acima de 0.12 e dominante
        ['shame', 0.05],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.message).toContain('constrangimento detectado');
      expect(result?.tips).toContain('Reduza a pressão');
    });

    it('deve gerar mensagem específica para sadness', () => {
      const emotions = new Map<string, number>([
        ['sadness', 0.12], // Acima de 0.10 e dominante
        ['disappointment', 0.05],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.message).toContain('tristeza detectada');
      expect(result?.tips).toContain('Valide a tristeza');
    });

    it('deve gerar mensagem específica para disappointment', () => {
      const emotions = new Map<string, number>([
        ['disappointment', 0.12], // Acima de 0.10 e dominante
        ['sadness', 0.05],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.message).toContain('decepção detectada');
      expect(result?.tips).toContain('Valide a decepção');
    });

    it('deve gerar mensagem específica para disapproval', () => {
      const emotions = new Map<string, number>([
        ['disapproval', 0.10], // Acima de 0.08 e dominante
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.message).toContain('desaprovação detectada');
      expect(result?.tips).toContain('Explore diferentes pontos de vista');
    });
  });

  describe('Cenário FASE 6 - Novas emoções de tristeza', () => {
    it('deve detectar tristeza quando grief está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['grief', 0.12], // Acima de 0.11
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
      expect(result?.message).toContain('luto detectado');
    });

    it('deve detectar tristeza quando loneliness está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['loneliness', 0.12], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
      expect(result?.message).toContain('solidão detectada');
    });

    it('deve detectar tristeza quando melancholy está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['melancholy', 0.12], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
      expect(result?.message).toContain('melancolia detectada');
    });

    it('deve detectar tristeza quando regret está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['regret', 0.15], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
      expect(result?.message).toContain('arrependimento detectado');
    });

    it('deve detectar tristeza quando sorrow está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['sorrow', 0.12], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
      expect(result?.message).toContain('pesar detectado');
    });

    it('deve detectar tristeza quando despair está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['despair', 0.12], // Acima de 0.11
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
      expect(result?.message).toContain('desespero detectado');
      expect(result?.severity).toBe('info'); // Despair < 0.15 = info
    });

    it('deve gerar severidade warning quando despair está muito alto', () => {
      const emotions = new Map<string, number>([
        ['despair', 0.16], // Acima de 0.15
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.severity).toBe('warning');
    });

    it('deve gerar severidade warning quando grief está muito alto', () => {
      const emotions = new Map<string, number>([
        ['grief', 0.16], // Acima de 0.15
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.severity).toBe('warning');
    });
  });

  describe('Cenário FASE 10.3.2 - Thresholds dinâmicos por padrão temporal e validação por tendência consistente', () => {
    it('deve usar threshold reduzido quando há tendência crescente (emoção aumentou > 0.02 nos últimos 10s)', () => {
      const emotions = new Map<string, number>([
        ['grief', 0.095], // Threshold base = 0.11, reduzido 10% (tensão) = 0.099, reduzido 15% (tendência) = 0.08415, então 0.095 > 0.08415
      ]);
      const state = createMockState(emotions, -0.1, 0.6); // Alta tensão
      const ctx = createMockCtx();
      
      // Simula histórico com tendência crescente (scores aumentando)
      const mockGetRecentEmotions = jest.fn(() => [
        { type: 'tristeza', ts: Date.now() - 8000, score: 0.08 }, // Mais antigo
        { type: 'tristeza', ts: Date.now() - 5000, score: 0.09 }, // Meio
        { type: 'tristeza', ts: Date.now() - 2000, score: 0.10 }, // Mais recente (aumentou > 0.02)
      ]);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;
      (ctx as any).getEmotionTrend = jest.fn(() => 'increasing');

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });

    it('deve usar threshold aumentado quando há tendência decrescente (emoção diminuiu > 0.02 nos últimos 10s)', () => {
      const emotions = new Map<string, number>([
        ['grief', 0.10], // Threshold base = 0.11, aumentado 10% (tendência) = 0.121, então 0.10 < 0.121 (não detecta)
      ]);
      const state = createMockState(emotions, -0.05); // Tensão moderada (não alta, para não reduzir threshold), mas valence <= 0.1 (passa validação)
      const ctx = createMockCtx();
      
      // Simula histórico com tendência decrescente (scores diminuindo)
      const mockGetRecentEmotions = jest.fn(() => [
        { type: 'tristeza', ts: Date.now() - 8000, score: 0.12 }, // Mais antigo (maior)
        { type: 'tristeza', ts: Date.now() - 5000, score: 0.10 }, // Meio
        { type: 'tristeza', ts: Date.now() - 2000, score: 0.08 }, // Mais recente (diminuiu > 0.02)
      ]);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;
      (ctx as any).getEmotionTrend = jest.fn(() => 'decreasing');

      const result = detectSadness(state, ctx);

      // Com threshold aumentado, 0.10 não passa
      expect(result).toBeNull();
      // getRecentEmotions é chamado dentro de getEmotionTrendValue, que é chamado antes das validações
      expect((ctx as any).getEmotionTrend).toHaveBeenCalled();
    });

    it('deve reduzir threshold adicional quando há tendência consistente (3+ detecções consecutivas)', () => {
      const emotions = new Map<string, number>([
        ['grief', 0.092], // Threshold base = 0.11, reduzido 10% (tensão) = 0.099, reduzido mais 10% (tendência) = 0.0891, então 0.092 > 0.0891
      ]);
      const state = createMockState(emotions, -0.1, 0.6); // Alta tensão
      const ctx = createMockCtx();
      
      // Simula histórico com 3+ detecções consecutivas (gaps < 15s)
      const mockGetRecentEmotions = jest.fn((state, windowMs, now) => {
        if (windowMs === 30_000) {
          // Para validação de tendência consistente (janela de 30s)
          return [
            { type: 'tristeza', ts: now - 10000 }, // 10s atrás
            { type: 'tristeza', ts: now - 5000 }, // 5s atrás (gap de 5s < 15s)
            { type: 'tristeza', ts: now - 2000 }, // 2s atrás (gap de 3s < 15s)
          ];
        }
        // Para cálculo de tendência (janela de 10s) - retorna vazio para usar fallback
        return [];
      });
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('tristeza');
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });

    it('deve contextualizar mensagem quando há engajamento recente', () => {
      const emotions = new Map<string, number>([
        ['sadness', 0.12], // Acima do threshold
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();
      
      // Simula histórico de engajamento recente
      const mockGetRecentEmotions = jest.fn(() => [
        { type: 'entusiasmo_alto', ts: Date.now() - 30000 }, // 30s atrás (dentro da janela de 60s)
      ]);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectSadness(state, ctx);

      expect(result).not.toBeNull();
      // Mensagem deve ser contextualizada
      expect(result?.message).toContain('perdido o engajamento anterior');
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });
  });
});

