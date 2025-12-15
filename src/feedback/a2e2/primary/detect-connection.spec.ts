import { detectConnection } from './detect-connection';
import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

describe('detectConnection', () => {
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

  const createMockState = (emotions: Map<string, number>, valence = 0.1, arousal = 0.3) => ({
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

  describe('Cenário Positivo - Detecta conexão', () => {
    it('deve detectar conexão quando affection está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10], // Acima de 0.07
        ['love', 0.02],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('conexao');
      expect(result?.severity).toBe('info');
      expect(ctx.setCooldown).toHaveBeenCalled();
    });

    it('deve detectar conexão quando love está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['love', 0.10], // Acima de 0.07
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('conexao');
    });

    it('deve detectar conexão quando sympathy está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['sympathy', 0.10], // Acima de 0.07
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('conexao');
    });

    it('deve detectar conexão quando emphatic pain está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['emphatic pain', 0.10], // Acima de 0.07
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('conexao');
    });
  });

  describe('Cenário Negativo - Não detecta conexão', () => {
    it('não deve detectar quando todas as emoções estão abaixo do threshold', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.05], // Abaixo de 0.07
        ['love', 0.03],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando valence está muito negativo', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
      ]);
      const state = createMockState(emotions, -0.3, 0.3); // Valence muito negativo (< -0.2)
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando arousal está muito baixo', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
      ]);
      const state = createMockState(emotions, 0.1, 0.05); // Arousal muito baixo (< 0.1)
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando arousal está muito alto', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
      ]);
      const state = createMockState(emotions, 0.1, 0.7); // Arousal muito alto (> 0.6)
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade significativa', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['anger', 0.06], // Acima de 0.05
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando está em cooldown', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();
      ctx.inCooldown = jest.fn(() => true);

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há frustração muito alta', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['frustration', 0.13], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há medo significativo', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['fear', 0.06], // Acima de 0.05
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade extrema (rage)', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['rage', 0.06], // Acima de 0.05
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há tristeza muito alta (despair > 0.12) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['despair', 0.13], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há tristeza muito alta (grief > 0.12) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['grief', 0.13], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há tristeza muito alta (sorrow > 0.12) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['sorrow', 0.13], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade moderada (rage > 0.06) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['rage', 0.07], // Acima de 0.06, abaixo de 0.05 (threshold básico)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade moderada (anger > 0.06) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['anger', 0.07], // Acima de 0.06
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há combinação hostilidade + frustração (rage > 0.05 && frustration > 0.08) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['rage', 0.06], // Acima de 0.05
        ['frustration', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há combinação hostilidade + frustração (anger > 0.05 && frustration > 0.08) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['anger', 0.06], // Acima de 0.05
        ['frustration', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há combinação tristeza + frustração (sadness > 0.08 && frustration > 0.08) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['sadness', 0.09], // Acima de 0.08
        ['frustration', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há combinação hostilidade + tristeza (rage > 0.05 && sadness > 0.08) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['rage', 0.06], // Acima de 0.05
        ['sadness', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há medo/ameaça moderada (terror > 0.06) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['terror', 0.07], // Acima de 0.06
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há medo/ameaça moderada (fear > 0.06) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['fear', 0.07], // Acima de 0.06
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há tristeza moderada (sadness > 0.10) - FASE 10.2', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['sadness', 0.11], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há frustração moderada (frustration > 0.10) - FASE 10.2', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10],
        ['frustration', 0.11], // Acima de 0.10
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário FASE 10.2 - Validações baseadas em intensidade relativa', () => {
    it('não deve detectar quando frustração é 40% maior que conexão (frustration > score * 1.4)', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10], // Score = 0.10
        ['frustration', 0.15], // Frustração = 0.15 (50% maior que 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando hostilidade é 30% maior que conexão (hostilityScore > score * 1.3)', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10], // Score = 0.10
        ['rage', 0.14], // Hostilidade = 0.14 (40% maior que 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando tristeza é 20% maior que conexão (sadnessScore > score * 1.2)', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10], // Score = 0.10
        ['sadness', 0.13], // Tristeza = 0.13 (30% maior que 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário FASE 10.2 - Validações baseadas em subcategorias de conexão', () => {
    it('não deve detectar conexão profunda quando hostilidade é 50% maior que conexão profunda (hostilityScore > deepConnectionScore * 1.5)', () => {
      const emotions = new Map<string, number>([
        ['love', 0.10], // Deep connection = 0.10
        ['rage', 0.16], // Hostilidade = 0.16 (60% maior que 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar conexão leve quando hostilidade é 30% maior que conexão leve (hostilityScore > lightConnectionScore * 1.3)', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10], // Light connection = 0.10
        ['rage', 0.14], // Hostilidade = 0.14 (40% maior que 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('deve detectar conexão profunda quando hostilidade é menor que threshold relativo (hostilityScore <= deepConnectionScore * 1.5)', () => {
      const emotions = new Map<string, number>([
        ['love', 0.10], // Deep connection = 0.10
        ['rage', 0.04], // Hostilidade = 0.04 (40% maior, mas não 50%, e abaixo de 0.05 que bloqueia)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('conexao');
    });

    it('não deve detectar conexão profunda quando tristeza é 50% maior que conexão profunda (sadnessScore > deepConnectionScore * 1.5)', () => {
      const emotions = new Map<string, number>([
        ['emphatic pain', 0.10], // Deep connection = 0.10
        ['grief', 0.16], // Tristeza = 0.16 (60% maior que 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar conexão leve quando frustração é 30% maior que conexão leve (frustration > lightConnectionScore * 1.3)', () => {
      const emotions = new Map<string, number>([
        ['sympathy', 0.10], // Light connection = 0.10
        ['frustration', 0.14], // Frustração = 0.14 (40% maior que 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário FASE 5 - Mensagens específicas por emoção', () => {
    it('deve gerar mensagem específica para love', () => {
      const emotions = new Map<string, number>([
        ['love', 0.10], // Acima de 0.07 e dominante
        ['affection', 0.05],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.message).toContain('vínculo profundo detectado');
      expect(result?.tips).toContain('Reconheça o vínculo');
    });

    it('deve gerar mensagem específica para affection', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10], // Acima de 0.07 e dominante
        ['love', 0.05],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.message).toContain('carinho leve detectado');
      expect(result?.tips).toContain('Aproveite o momento de carinho');
    });

    it('deve gerar mensagem específica para sympathy', () => {
      const emotions = new Map<string, number>([
        ['sympathy', 0.10], // Acima de 0.07 e dominante
        ['affection', 0.05],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.message).toContain('compaixão detectada');
      expect(result?.tips).toContain('Reconheça a compaixão');
    });

    it('deve gerar mensagem específica para emphatic pain', () => {
      const emotions = new Map<string, number>([
        ['emphatic pain', 0.10], // Acima de 0.07 e dominante
        ['affection', 0.05],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.message).toContain('sofrimento empático detectado');
      expect(result?.tips).toContain('Valide o sofrimento');
    });
  });

  describe('Cenário FASE 10.3.3 - Thresholds dinâmicos por baixa tensão e mensagens contextuais por intensidade relativa', () => {
    it('deve usar threshold reduzido em baixa tensão (arousal < 0.2 && valence > 0.2)', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.064], // Threshold base = 0.07, reduzido 10% = 0.063, então 0.064 > 0.063 (baixa tensão)
      ]);
      const state = createMockState(emotions, 0.3, 0.1); // Baixa tensão: valence positivo, arousal baixo (mas >= 0.1 para passar validação)
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('conexao');
    });

    it('não deve detectar com threshold base quando não há baixa tensão', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.063], // Abaixo do threshold base 0.07
      ]);
      const state = createMockState(emotions, 0.3, 0.4); // Tensão moderada
      const ctx = createMockCtx();

      const result = detectConnection(state, ctx);

      expect(result).toBeNull();
    });

    it('deve contextualizar mensagem quando há intensidade relativa moderada (60-80%) de hostilidade', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10], // Conexão = 0.10
        ['anger', 0.07], // Hostilidade = 0.07 (70% de 0.10, dentro de 60-80%)
      ]);
      const state = createMockState(emotions, 0.1, 0.3);
      const ctx = createMockCtx();
      
      // Simula histórico sem emoções recentes (para não bloquear)
      const mockGetRecentEmotions = jest.fn(() => []);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      // Mensagem deve ser contextualizada
      expect(result?.message).toContain('mas há alguma tensão no ambiente');
      expect(result?.tips).toContain('Considere abordar a tensão com empatia');
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });

    it('deve contextualizar mensagem quando há intensidade relativa moderada (60-80%) de tristeza', () => {
      const emotions = new Map<string, number>([
        ['love', 0.10], // Conexão = 0.10
        ['sadness', 0.07], // Tristeza = 0.07 (70% de 0.10, dentro de 60-80%)
      ]);
      const state = createMockState(emotions, 0.1, 0.3);
      const ctx = createMockCtx();
      
      // Simula histórico sem emoções recentes (para não bloquear)
      const mockGetRecentEmotions = jest.fn(() => []);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      // Mensagem deve ser contextualizada
      expect(result?.message).toContain('mas há alguma tensão no ambiente');
      expect(result?.tips).toContain('Considere abordar a tensão com empatia');
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });

    it('deve contextualizar mensagem quando há intensidade relativa moderada (60-80%) de frustração', () => {
      const emotions = new Map<string, number>([
        ['sympathy', 0.10], // Conexão = 0.10
        ['frustration', 0.07], // Frustração = 0.07 (70% de 0.10, dentro de 60-80%)
      ]);
      const state = createMockState(emotions, 0.1, 0.3);
      const ctx = createMockCtx();
      
      // Simula histórico sem emoções recentes (para não bloquear)
      const mockGetRecentEmotions = jest.fn(() => []);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      // Mensagem deve ser contextualizada
      expect(result?.message).toContain('mas há alguma tensão no ambiente');
      expect(result?.tips).toContain('Considere abordar a tensão com empatia');
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });

    it('não deve contextualizar mensagem quando intensidade relativa está abaixo de 60%', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10], // Conexão = 0.10
        ['anger', 0.05], // Hostilidade = 0.05 (50% de 0.10, abaixo de 60%)
      ]);
      const state = createMockState(emotions, 0.1, 0.3);
      const ctx = createMockCtx();
      
      // Simula histórico sem emoções recentes (para não bloquear)
      const mockGetRecentEmotions = jest.fn(() => []);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectConnection(state, ctx);

      expect(result).not.toBeNull();
      // Mensagem não deve ser contextualizada
      expect(result?.message).not.toContain('mas há alguma tensão no ambiente');
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });

    it('não deve contextualizar mensagem quando intensidade relativa está acima de 80% (deve bloquear)', () => {
      const emotions = new Map<string, number>([
        ['affection', 0.10], // Conexão = 0.10
        ['anger', 0.09], // Hostilidade = 0.09 (90% de 0.10, acima de 80%)
      ]);
      const state = createMockState(emotions, 0.1, 0.3);
      const ctx = createMockCtx();
      
      // Simula histórico sem emoções recentes (para não bloquear)
      const mockGetRecentEmotions = jest.fn(() => []);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectConnection(state, ctx);

      // Deve bloquear porque hostilidade é muito alta (90% > 80%)
      expect(result).toBeNull();
    });
  });
});

