import { detectSerenity } from './detect-serenity';
import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

describe('detectSerenity', () => {
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

  const createMockState = (emotions: Map<string, number>, valence = 0.1, arousal = 0.2) => ({
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

  describe('Cenário Positivo - Detecta serenidade', () => {
    it('deve detectar serenidade quando calmness está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10], // Acima de 0.08
        ['contentment', 0.02],
        ['relief', 0.01],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('serenidade');
      expect(result?.severity).toBe('info');
      expect(result?.message).toContain('calma detectada');
      expect(result?.tips).toContain('Aproveite a calma');
      expect(ctx.setCooldown).toHaveBeenCalled();
    });

    it('deve detectar serenidade quando contentment está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.02],
        ['contentment', 0.10], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('serenidade');
      expect(result?.message).toContain('contentamento detectado');
      expect(result?.tips).toContain('Reconheça o contentamento');
    });

    it('deve detectar serenidade quando relief está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['relief', 0.10], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('serenidade');
      expect(result?.message).toContain('alívio detectado');
      expect(result?.tips).toContain('Reconheça o alívio');
    });

    it('deve detectar serenidade quando satisfaction está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['satisfaction', 0.10], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('serenidade');
      expect(result?.message).toContain('satisfação detectada');
      expect(result?.tips).toContain('Reconheça a satisfação');
    });

    it('deve usar mensagem genérica quando múltiplas emoções estão no mesmo nível', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.09],
        ['contentment', 0.09], // Mesmo nível
        ['relief', 0.09],
        ['satisfaction', 0.09],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.message).toContain('ambiente tranquilo detectado');
    });
  });

  describe('Cenário Negativo - Não detecta serenidade', () => {
    it('não deve detectar quando todas as emoções estão abaixo do threshold', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.05], // Abaixo de 0.08
        ['contentment', 0.03],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando arousal está muito alto', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
      ]);
      const state = createMockState(emotions, 0.1, 0.5); // Arousal muito alto (> 0.4)
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando valence está negativo', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
      ]);
      const state = createMockState(emotions, -0.1, 0.2); // Valence negativo
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade significativa', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['anger', 0.06], // Acima de 0.05
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há frustração significativa', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['frustration', 0.12], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há desespero muito alto (despair > 0.12) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['despair', 0.13], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há luto muito alto (grief > 0.12) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['grief', 0.13], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há tristeza moderada-alta (sorrow > 0.10) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['sorrow', 0.11], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há tristeza moderada-alta (sadness > 0.10) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['sadness', 0.11], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há melancolia moderada-alta (melancholy > 0.10) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['melancholy', 0.11], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade baixa (rage > 0.04) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['rage', 0.05], // Acima de 0.04, abaixo de 0.05 (threshold básico)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade baixa (anger > 0.04) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['anger', 0.05], // Acima de 0.04
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há combinação hostilidade + frustração (rage > 0.04 && frustration > 0.06) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['rage', 0.05], // Acima de 0.04
        ['frustration', 0.07], // Acima de 0.06
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há combinação hostilidade + frustração (anger > 0.04 && frustration > 0.06) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['anger', 0.05], // Acima de 0.04
        ['frustration', 0.07], // Acima de 0.06
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há combinação tristeza + frustração (sadness > 0.08 && frustration > 0.06) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['sadness', 0.09], // Acima de 0.08
        ['frustration', 0.07], // Acima de 0.06
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há combinação hostilidade + tristeza (rage > 0.04 && sadness > 0.08) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['rage', 0.05], // Acima de 0.04
        ['sadness', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há medo/ameaça baixa (terror > 0.04) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['terror', 0.05], // Acima de 0.04
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há medo/ameaça baixa (fear > 0.04) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['fear', 0.05], // Acima de 0.04
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há tristeza baixa (sadness > 0.08) - FASE 10.2', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['sadness', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há frustração baixa (frustration > 0.08) - FASE 10.2', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
        ['frustration', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando está em cooldown', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();
      ctx.inCooldown = jest.fn(() => true);

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há poucas amostras', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();
      (ctx.window as jest.Mock).mockImplementation(() => ({
        start: now - longWindowMs,
        end: now,
        samplesCount: 5, // Menos de 6
        speechCount: 4,
      }));

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário FASE 10.2 - Validações baseadas em intensidade relativa', () => {
    it('não deve detectar quando hostilidade é igual ou maior que serenidade (hostilityScore >= score * 1.0)', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10], // Score = 0.10
        ['rage', 0.10], // Hostilidade = 0.10 (igual a 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando tristeza é 80% da serenidade (sadnessScore > score * 0.8)', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10], // Score = 0.10
        ['sadness', 0.09], // Tristeza = 0.09 (90% de 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando frustração é 60% da serenidade (frustration > score * 0.6)', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10], // Score = 0.10
        ['frustration', 0.07], // Frustração = 0.07 (70% de 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário FASE 10.2 - Validações baseadas em subcategorias de serenidade', () => {
    it('não deve detectar serenidade reativa quando hostilidade é 80% da serenidade reativa (hostilityScore > reactiveSerenityScore * 0.8)', () => {
      const emotions = new Map<string, number>([
        ['relief', 0.10], // Reactive serenity = 0.10
        ['rage', 0.09], // Hostilidade = 0.09 (90% de 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar serenidade basal quando hostilidade é 60% da serenidade basal (hostilityScore > basalSerenityScore * 0.6)', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10], // Basal serenity = 0.10
        ['rage', 0.07], // Hostilidade = 0.07 (70% de 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('deve detectar serenidade reativa quando hostilidade é menor que threshold relativo (hostilityScore <= reactiveSerenityScore * 0.8)', () => {
      const emotions = new Map<string, number>([
        ['satisfaction', 0.10], // Reactive serenity = 0.10
        ['rage', 0.03], // Hostilidade = 0.03 (30% de 0.10, abaixo de 0.04 que bloqueia)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('serenidade');
    });

    it('não deve detectar serenidade reativa quando tristeza é 80% da serenidade reativa (sadnessScore > reactiveSerenityScore * 0.8)', () => {
      const emotions = new Map<string, number>([
        ['relief', 0.10], // Reactive serenity = 0.10
        ['sadness', 0.09], // Tristeza = 0.09 (90% de 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar serenidade basal quando frustração é 60% da serenidade basal (frustration > basalSerenityScore * 0.6)', () => {
      const emotions = new Map<string, number>([
        ['contentment', 0.10], // Basal serenity = 0.10
        ['frustration', 0.07], // Frustração = 0.07 (70% de 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário FASE 10.3.2 - Mensagens contextuais para serenidade após tensão', () => {
    it('deve contextualizar mensagem quando há hostilidade recente', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10], // Acima do threshold
      ]);
      const state = createMockState(emotions, 0.1, 0.2);
      const ctx = createMockCtx();
      
      // Simula histórico de hostilidade recente
      const mockGetRecentEmotions = jest.fn(() => [
        { type: 'hostilidade', ts: Date.now() - 30000 }, // 30s atrás (dentro da janela de 60s)
      ]);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectSerenity(state, ctx);

      expect(result).not.toBeNull();
      // Mensagem deve ser contextualizada
      expect(result?.message).toContain('se acalmando');
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });

    it('deve contextualizar mensagem quando há frustração recente', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10], // Acima do threshold
      ]);
      const state = createMockState(emotions, 0.1, 0.2);
      const ctx = createMockCtx();
      
      // Simula histórico de frustração recente
      const mockGetRecentEmotions = jest.fn(() => [
        { type: 'frustracao_crescente', ts: Date.now() - 30000 }, // 30s atrás (dentro da janela de 60s)
      ]);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectSerenity(state, ctx);

      expect(result).not.toBeNull();
      // Mensagem deve ser contextualizada
      expect(result?.message).toContain('se acalmando');
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });

    it('não deve contextualizar mensagem quando não há tensão recente', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.10], // Acima do threshold
      ]);
      const state = createMockState(emotions, 0.1, 0.2);
      const ctx = createMockCtx();
      
      // Simula histórico sem hostilidade ou frustração recente
      const mockGetRecentEmotions = jest.fn(() => [
        { type: 'serenidade', ts: Date.now() - 30000 }, // Apenas serenidade anterior
      ]);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectSerenity(state, ctx);

      expect(result).not.toBeNull();
      // Mensagem não deve ser contextualizada
      expect(result?.message).not.toContain('se acalmando');
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });
  });

  describe('Cenário FASE 10.3.3 - Thresholds dinâmicos por baixa tensão', () => {
    it('deve usar threshold reduzido em baixa tensão (arousal < 0.2 && valence > 0.2)', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.069], // Threshold base = 0.08, reduzido 15% = 0.068, então 0.069 > 0.068 (baixa tensão)
      ]);
      const state = createMockState(emotions, 0.3, 0.1); // Baixa tensão: valence positivo, arousal baixo
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('serenidade');
    });

    it('não deve detectar com threshold base quando não há baixa tensão', () => {
      const emotions = new Map<string, number>([
        ['calmness', 0.068], // Abaixo do threshold base 0.08
      ]);
      const state = createMockState(emotions, 0.3, 0.4); // Tensão moderada
      const ctx = createMockCtx();

      const result = detectSerenity(state, ctx);

      expect(result).toBeNull();
    });
  });
});

