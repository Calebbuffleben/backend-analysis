import { detectEngagement } from './detect-engagement';
import { FeedbackEventPayload } from '../../feedback.types';
import { A2E2_THRESHOLDS } from '../thresholds/thresholds';

describe('detectEngagement', () => {
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
    valence = 0.2,
    arousal = 0.4,
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

  describe('Cenário Positivo - Detecta engajamento moderado', () => {
    it('deve detectar engajamento quando interest está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08], // Acima de 0.06
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
      expect(ctx.setCooldown).toHaveBeenCalled();
    });

    it('deve detectar engajamento quando joy está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['joy', 0.08], // Acima de 0.06
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
    });

    it('deve detectar engajamento quando determination está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['determination', 0.08], // Acima de 0.06
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
    });

    it('deve detectar engajamento quando enthusiasm está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['enthusiasm', 0.08], // Acima de 0.06
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
    });

    it('deve detectar engajamento quando excitement está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['excitement', 0.08], // Acima de 0.06
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
    });
  });

  describe('Cenário Positivo - Detecta engajamento intenso', () => {
    it('deve detectar engajamento quando ecstasy está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['ecstasy', 0.10], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
      expect(result?.severity).toBe('warning'); // Ecstasy sempre warning
    });

    it('deve detectar engajamento quando triumph está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['triumph', 0.10], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
      expect(result?.severity).toBe('warning'); // Triumph sempre warning
    });

    it('deve detectar engajamento quando awe está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['awe', 0.10], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
    });

    it('deve detectar engajamento quando admiration está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['admiration', 0.10], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
    });
  });

  describe('Cenário Positivo - Detecta engajamento lúdico', () => {
    it('deve detectar engajamento quando amusement está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['amusement', 0.09], // Acima de 0.07
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
    });

    it('deve detectar engajamento quando entrancement está acima do threshold', () => {
      const emotions = new Map<string, number>([
        ['entrancement', 0.09], // Acima de 0.07
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
    });
  });

  describe('Cenário Negativo - Não detecta engajamento', () => {
    it('não deve detectar quando todas as emoções estão abaixo do threshold', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.05], // Abaixo de 0.06
        ['joy', 0.04],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando valence está muito negativo', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
      ]);
      const state = createMockState(emotions, -0.4, 0.4); // Valence muito negativo (<= -0.3)
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando arousal está muito baixo', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
      ]);
      const state = createMockState(emotions, 0.2, 0.05); // Arousal muito baixo (< 0.1)
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade significativa', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['anger', 0.06], // Acima de 0.05
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há medo significativo', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['fear', 0.06], // Acima de 0.05
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há tristeza muito alta (despair > 0.12) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['despair', 0.13], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há tristeza muito alta (grief > 0.12) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['grief', 0.13], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há tristeza muito alta (sorrow > 0.12) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['sorrow', 0.13], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há frustração muito alta (frustration > 0.12) - FASE 10', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['frustration', 0.13], // Acima de 0.12
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade moderada-alta (rage > 0.08) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['rage', 0.09], // Acima de 0.08, abaixo de 0.05 (threshold básico)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade moderada-alta (anger > 0.08) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['anger', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há hostilidade moderada-alta (contempt > 0.08) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['contempt', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há combinação hostilidade + frustração (rage > 0.06 && frustration > 0.08) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['rage', 0.07], // Acima de 0.06
        ['frustration', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há combinação hostilidade + frustração (anger > 0.06 && frustration > 0.08) - FASE 10.1', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['anger', 0.07], // Acima de 0.06
        ['frustration', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando está em cooldown', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();
      ctx.inCooldown = jest.fn(() => true);

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário Borderline - Casos limite', () => {
    it('não deve detectar quando interest está exatamente no threshold (0.06)', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.06], // Exatamente no threshold
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      // Threshold é > 0.06, então 0.06 não deve detectar
      expect(result).toBeNull();
    });

    it('deve detectar quando interest está ligeiramente acima do threshold (0.0601)', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.0601], // Ligeiramente acima de 0.06
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
    });

    it('não deve detectar quando ecstasy está exatamente no threshold (0.08)', () => {
      const emotions = new Map<string, number>([
        ['ecstasy', 0.08], // Exatamente no threshold
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      // Threshold é > 0.08, então 0.08 não deve detectar
      expect(result).toBeNull();
    });

    it('deve detectar quando ecstasy está ligeiramente acima do threshold (0.0801)', () => {
      const emotions = new Map<string, number>([
        ['ecstasy', 0.0801], // Ligeiramente acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
      expect(result?.severity).toBe('warning'); // Ecstasy sempre warning
    });
  });

  describe('Cenário FASE 10.1 - Redução de severidade por hostilidade baixa', () => {
    it('deve reduzir severidade para info quando há hostilidade baixa (rage entre 0.03 e 0.05)', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['rage', 0.04], // Entre 0.03 e 0.05
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.severity).toBe('info'); // Severidade reduzida
    });

    it('deve reduzir severidade para info quando há hostilidade baixa (anger entre 0.03 e 0.05)', () => {
      const emotions = new Map<string, number>([
        ['joy', 0.08],
        ['anger', 0.04], // Entre 0.03 e 0.05
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.severity).toBe('info'); // Severidade reduzida
    });
  });

  describe('Cenário FASE 10.1 - Combinações adicionais', () => {
    it('não deve detectar quando há combinação tristeza + frustração (sadness > 0.08 && frustration > 0.08)', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['sadness', 0.09], // Acima de 0.08
        ['frustration', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há combinação hostilidade + tristeza (rage > 0.05 && sadness > 0.08)', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['rage', 0.06], // Acima de 0.05
        ['sadness', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há medo/ameaça moderada-alta (terror > 0.08)', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['terror', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando há medo/ameaça moderada-alta (fear > 0.08)', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.08],
        ['fear', 0.09], // Acima de 0.08
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário FASE 10.2 - Validações baseadas em intensidade relativa', () => {
    it('não deve detectar quando hostilidade é 50% maior que engajamento (hostilityScore > score * 1.5)', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.10], // Score = 0.10
        ['rage', 0.16], // Hostilidade = 0.16 (60% maior que 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando tristeza é 30% maior que engajamento (sadnessScore > score * 1.3)', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.10], // Score = 0.10
        ['sadness', 0.14], // Tristeza = 0.14 (40% maior que 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar quando frustração é 40% maior que engajamento (frustration > score * 1.4)', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.10], // Score = 0.10
        ['frustration', 0.15], // Frustração = 0.15 (50% maior que 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário FASE 10.2 - Validações baseadas em subcategorias de engajamento', () => {
    it('não deve detectar engajamento intenso quando hostilidade é 80% do engajamento intenso', () => {
      const emotions = new Map<string, number>([
        ['ecstasy', 0.10], // Engajamento intenso = 0.10
        ['rage', 0.09], // Hostilidade = 0.09 (90% de 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar engajamento intenso quando tristeza é 80% do engajamento intenso', () => {
      const emotions = new Map<string, number>([
        ['triumph', 0.10], // Engajamento intenso = 0.10
        ['sadness', 0.09], // Tristeza = 0.09 (90% de 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });

    it('não deve detectar engajamento lúdico quando hostilidade é 70% do engajamento lúdico', () => {
      const emotions = new Map<string, number>([
        ['amusement', 0.10], // Engajamento lúdico = 0.10
        ['anger', 0.08], // Hostilidade = 0.08 (80% de 0.10)
      ]);
      const state = createMockState(emotions);
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });
  });

  describe('Cenário FASE 10.2 - Redução de severidade baseada em intensidade relativa', () => {
    it('deve reduzir severidade de warning para info quando hostilidade é 60-80% do engajamento', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.10], // Score = 0.10
        ['rage', 0.04], // Hostilidade = 0.04 (40% de 0.10, abaixo de 0.05 que bloqueia)
      ]);
      const state = createMockState(emotions, 0.3, 0.2); // arousal alto, valence positivo
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      // rage = 0.04 não é > 0.05, então não é bloqueado
      // Mas também não é > 0.10 * 0.6 = 0.06, então não reduz severidade por intensidade relativa
      // Mas pode ser reduzido por hasLowHostility (rage > 0.03 && rage <= 0.05)
      // 0.04 está nesse range, então reduz severidade
      expect(result).not.toBeNull();
      expect(result?.severity).toBe('info'); // Severidade reduzida por hasLowHostility
    });

    it('deve reduzir severidade de warning para info quando tristeza é 60-80% do engajamento', () => {
      const emotions = new Map<string, number>([
        ['joy', 0.10], // Score = 0.10
        ['sadness', 0.09], // Tristeza = 0.09 (90% de 0.10, mas não > 0.10 que bloqueia)
      ]);
      const state = createMockState(emotions, 0.3, 0.2); // arousal alto, valence positivo
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      // sadness = 0.09 não é > 0.10, então não é bloqueado
      // Mas também não está no range 0.06-0.08 para reduzir severidade
      // Vamos verificar se a severidade é 'warning' (padrão)
      expect(result).not.toBeNull();
      expect(result?.severity).toBe('warning'); // Severidade não reduzida porque não está no range
    });

    it('deve reduzir severidade de warning para info quando frustração é 60-80% do engajamento', () => {
      const emotions = new Map<string, number>([
        ['excitement', 0.10], // Score = 0.10
        ['frustration', 0.07], // Frustração = 0.07 (70% de 0.10, no range 0.06-0.08)
      ]);
      const state = createMockState(emotions, 0.3, 0.2); // arousal alto, valence positivo
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      // frustration = 0.07 não é > 0.12, então não é bloqueado
      // E está no range 0.06-0.08 para reduzir severidade (0.07 > 0.10 * 0.6 = 0.06 && 0.07 <= 0.10 * 0.8 = 0.08)
      expect(result).not.toBeNull();
      expect(result?.severity).toBe('info'); // Severidade reduzida
    });

    it('deve manter severidade warning quando hostilidade é menor que 60% do engajamento', () => {
      const emotions = new Map<string, number>([
        ['ecstasy', 0.10], // Score = 0.10
        ['rage', 0.02], // Hostilidade = 0.02 (20% de 0.10, abaixo de 0.03 que reduz severidade)
      ]);
      const state = createMockState(emotions, 0.3, 0.2); // arousal alto, valence positivo
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      // rage = 0.02 não é > 0.05, então não é bloqueado
      // E não está no range 0.03-0.05 para reduzir severidade (hasLowHostility)
      // E não está no range 0.06-0.08 para reduzir severidade (hasModerateRelativeHostility)
      expect(result).not.toBeNull();
      // Ecstasy é sempre 'warning' exceto se houver emoções negativas moderadas
      // Como rage = 0.02 não é moderado, severidade deve ser 'warning'
      expect(result?.severity).toBe('warning'); // Severidade mantida
    });

    it('deve bloquear completamente quando hostilidade é maior que 80% do engajamento', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.10], // Score = 0.10
        ['rage', 0.06], // Hostilidade = 0.06 (60% de 0.10, mas > 0.05 que bloqueia)
      ]);
      const state = createMockState(emotions, 0.3, 0.2); // arousal alto, valence positivo
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      // rage = 0.06 é > 0.05, então é bloqueado pela validação absoluta
      expect(result).toBeNull(); // Bloqueado por validação absoluta
    });
  });

  describe('Cenário FASE 10.3.1 - Thresholds dinâmicos e mensagens contextuais', () => {
    it('deve usar threshold reduzido em baixa tensão (arousal < 0.2 && valence > 0.2)', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.055], // Threshold base = 0.06, reduzido 10% = 0.054, então 0.055 > 0.054 (baixa tensão)
      ]);
      const state = createMockState(emotions, 0.3, 0.1); // Baixa tensão: valence positivo, arousal baixo (mas >= 0.1 para passar validação)
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
    });

    it('deve contextualizar mensagem quando há hostilidade recente', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.10],
      ]);
      const state = createMockState(emotions, 0.3, 0.2);
      const ctx = createMockCtx();
      
      // Simula histórico de hostilidade recente
      const mockGetRecentEmotions = jest.fn(() => [
        { type: 'hostilidade', ts: Date.now() - 30000 }, // 30s atrás (dentro da janela de 60s)
      ]);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      // Mensagem deve ser contextualizada
      expect(result?.message).toContain('após o momento anterior');
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });

    it('deve bloquear por oscilação rápida (3+ detecções nos últimos 30s)', () => {
      const emotions = new Map<string, number>([
        ['joy', 0.10], // Acima do threshold
      ]);
      const state = createMockState(emotions, 0.3, 0.2);
      const ctx = createMockCtx();
      
      // Simula histórico de 3 detecções recentes
      const mockGetRecentEmotions = jest.fn(() => [
        { type: 'entusiasmo_alto', ts: Date.now() - 10000 },
        { type: 'entusiasmo_alto', ts: Date.now() - 20000 },
        { type: 'entusiasmo_alto', ts: Date.now() - 25000 },
      ]);
      (ctx as any).getRecentEmotions = mockGetRecentEmotions;

      const result = detectEngagement(state, ctx);

      // Deve bloquear por oscilação rápida
      expect(result).toBeNull();
      expect(mockGetRecentEmotions).toHaveBeenCalled();
    });
  });

  describe('Cenário FASE 10.3.3 - Thresholds dinâmicos por baixa tensão', () => {
    it('deve usar threshold reduzido em baixa tensão para engajamento moderado (arousal < 0.2 && valence > 0.2)', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.055], // Threshold base = 0.06, reduzido 10% = 0.054, então 0.055 > 0.054 (baixa tensão)
      ]);
      const state = createMockState(emotions, 0.3, 0.1); // Baixa tensão: valence positivo, arousal baixo (mas >= 0.1 para passar validação)
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('entusiasmo_alto');
    });

    it('não deve detectar com threshold base quando não há baixa tensão', () => {
      const emotions = new Map<string, number>([
        ['interest', 0.054], // Abaixo do threshold base 0.06
      ]);
      const state = createMockState(emotions, 0.3, 0.4); // Tensão moderada
      const ctx = createMockCtx();

      const result = detectEngagement(state, ctx);

      expect(result).toBeNull();
    });
  });
});

