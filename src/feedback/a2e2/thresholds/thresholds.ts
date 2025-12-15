/**
 * Arquitetura Emocional 2.0 (A2E2) - Thresholds Centralizados
 * 
 * Este arquivo contém todos os thresholds, gates, cooldowns e parâmetros
 * necessários para a detecção de estados emocionais e prosódicos.
 * 
 * Hierarquia de prioridade:
 * 1. Camada 1: Emoções Primárias (maior prioridade)
 * 2. Camada 2: Meta-Estados Emocionais
 * 3. Camada 3: Sinais Prosódicos
 * 4. Camada 4: Estados de Longo Prazo (menor prioridade)
 */

export const A2E2_THRESHOLDS = {
  /**
   * Camada 1: Emoções Primárias
   * 
   * Detecta emoções específicas baseadas em scores diretos do modelo de IA.
   * Valores são normalizados entre 0 e 1, onde 0.05 representa 5% de confiança.
   */
  primary: {
    /**
     * Threshold principal para considerar uma emoção como presente.
     * Emoções abaixo deste valor são ignoradas.
     */
    main: 0.01,

    /**
     * Threshold para considerar uma emoção como dominante.
     * Uma emoção é dominante quando seu score é muito maior que outras.
     */
    dominant: 0.10,

    /**
     * Crescimento rápido do EMA (Exponential Moving Average).
     * Indica aumento súbito de uma emoção.
     */
    rapidGrowth: 0.02,

    /**
     * Hostilidade: Detecta múltiplas emoções relacionadas a hostilidade e ameaça.
     * 
     * FASE 2: Expandido para incluir 6 novas emoções organizadas em subcategorias:
     * - Hostilidade Ativa: anger, disgust, distress, rage, contempt
     * - Medo/Ameaça: fear, horror, terror, anxiety
     * 
     * Thresholds por subcategoria:
     * - Hostilidade ativa: 0.07-0.10 (thresholds variados por intensidade)
     * - Medo/Ameaça: 0.08-0.12 (mais conservador, requer mais confiança)
     * 
     * Nota: Os valores anteriores estavam em 1.0 (efetivamente desabilitados).
     * FASE 2: Valores ajustados para thresholds funcionais baseados em análise de padrões.
     */
    hostility: {
      // CORREÇÃO: Hostilidade Ativa - thresholds aumentados para reduzir falsos positivos
      // Aumentados de 0.07 para 0.09 (+28%) para reduzir detecções de emoções leves
      anger: 0.20,      // Aumentado de 0.07
      disgust: 0.12,    // Aumentado de 0.07
      distress: 0.09,   // Aumentado de 0.07
      rage: 0.10,       // Aumentado de 0.08 (+25%)
      contempt: 0.09,   // Aumentado de 0.07
      
      // Medo/Ameaça - emoções de medo e ansiedade
      // CORREÇÃO: Thresholds aumentados para reduzir falsos positivos
      fear: 0.15,       // Aumentado de 0.10 (+20%)
      horror: 0.18,     // Aumentado de 0.12 (+25%)
      terror: 0.18,     // Aumentado de 0.12 (+25%)
      // CORREÇÃO: Anxiety aumentado de 0.08 para 0.12 para reduzir falsos positivos
      // Ansiedade leve é comum em conversas normais e não representa hostilidade
      anxiety: 0.12,    // Aumentado para reduzir falsos positivos de ansiedade leve
    },

    /**
     * Frustração: Detecta frustração através de múltiplos sinais.
     * Pode ser detectada via emoções primárias ou através de tendências
     * (arousal alto + valence baixo).
     * 
     * ETAPA 3: Threshold ajustado de 0.10 para 0.07 (+40% vs original 0.05).
     * Aumento moderado que mantém proteção contra ruído mas permite detecção de emoções moderadas.
     */
    frustration: {
      frustration: 0.15,
      // Também pode ser detectada via meta-estados (frustrationTrend)
    },

    /**
     * Tédio: Detecta boredom, tiredness e baixo interesse.
     * Interest deve estar abaixo do threshold para confirmar tédio.
     * 
     * ETAPA 3: Thresholds ajustados:
     * - boredom: 0.10 → 0.07 (+40% vs original 0.05)
     * - tiredness: 0.12 → 0.10 (+25% vs original 0.08)
     * Aumentos moderados que mantêm proteção contra ruído mas permitem detecção de emoções moderadas.
     */
    boredom: {
      boredom: 0.15,
      tiredness: 0.20,
      interestLow: 0.15, // Interest deve estar abaixo disso
    },

    /**
     * Confusão: Detecta confusion e doubt.
     * 
     * ETAPA 3: Thresholds ajustados de 0.10 para 0.07 (+40% vs original 0.05).
     * Aumento moderado que mantém proteção contra ruído mas permite detecção de emoções moderadas.
     */
    confusion: {
      confusion: 1,
      doubt: 0.15,
    },

    /**
     * Engajamento Positivo: Detecta múltiplas emoções de alta energia positiva.
     * 
     * FASE 3: Expandido para incluir 8 novas emoções organizadas em subcategorias:
     * - Engajamento Moderado: interest, joy, determination, enthusiasm, excitement
     * - Engajamento Intenso: ecstasy, triumph, awe, admiration
     * - Engajamento Lúdico: amusement, entrancement
     * 
     * Thresholds por subcategoria:
     * - Moderado: 0.06 (mantém atual, mais sensível)
     * - Intenso: 0.08 (mais alto, requer mais confiança)
     * - Lúdico: 0.07 (intermediário)
     */
    engagement: {
      // Engajamento Moderado
      interest: 0.06,
      joy: 0.06,
      determination: 0.06,
      enthusiasm: 0.06,
      excitement: 0.06,
      
      // Engajamento Intenso
      ecstasy: 0.08,
      triumph: 0.08,
      awe: 0.08,
      admiration: 0.08,
      
      // Engajamento Lúdico
      amusement: 0.07,
      entrancement: 0.07,
    },

    /**
     * Serenidade: Detecta calmness, contentment, relief e satisfaction.
     * Indica estado de tranquilidade e satisfação leve.
     * 
     * FASE 1: Thresholds iniciais definidos de forma conservadora.
     * Serenidade requer threshold mais alto que engajamento (0.08) pois é menos urgente.
     */
    serenity: {
      calmness: 0.08,
      contentment: 0.08,
      relief: 0.08,
      satisfaction: 0.08,
    },

    /**
     * Conexão Social: Detecta affection, emphatic pain, love e sympathy.
     * Indica conexão emocional e empatia entre participantes.
     * 
     * FASE 1: Thresholds iniciais definidos de forma conservadora.
     * Conexão requer threshold moderado (0.07) pois é positivo mas não urgente.
     */
    connection: {
      affection: 0.07,
      emphaticPain: 0.07,
      love: 0.07,
      sympathy: 0.07,
    },

    /**
     * Tristeza: Detecta múltiplas emoções relacionadas a estados emocionais negativos.
     * Indica estados emocionais negativos relacionados a perda, julgamento ou autoavaliação.
     * 
     * FASE 6: Expandido com 6 novas emoções (grief, loneliness, melancholy, regret, sorrow, despair).
     * Tristeza tem thresholds variados por subcategoria:
     * - Tristeza direta: 0.10 (sadness, disappointment, sorrow)
     * - Autoavaliação negativa: 0.12 (guilt, shame, embarrassment, regret)
     * - Julgamento: 0.08 (disapproval)
     * - Luto/Perda profunda: 0.11 (grief, despair)
     * - Isolamento: 0.10 (loneliness, melancholy)
     */
    sadness: {
      sadness: 0.10,
      disappointment: 0.10,
      guilt: 0.12,
      shame: 0.12,
      embarrassment: 0.12,
      disapproval: 0.08,
      // FASE 6: Novas emoções
      grief: 0.11,
      loneliness: 0.10,
      melancholy: 0.10,
      regret: 0.12,
      sorrow: 0.10,
      despair: 0.11,
    },

    /**
     * Estado Mental: Detecta múltiplos estados contextuais e neutros.
     * Inclui: awkwardness, concentration, contemplation, desire, nostalgia, pain, pride,
     * realization, surprise (positiva/negativa), envy, neutral.
     * 
     * FASE 7: Expandido com 11 novas emoções (curiosity, anticipation, hope, relief, satisfaction,
     * calmness, contentment, interest, confusion, doubt, boredom).
     * Estados mentais têm thresholds variados por subcategoria:
     * - Foco: 0.10 (concentration, contemplation)
     * - Desconforto social: 0.08 (awkwardness, envy)
     * - Sofrimento: 0.12 (pain)
     * - Autoafirmação: 0.09 (pride)
     * - Insight: 0.07 (realization)
     * - Memória afetiva: 0.10 (nostalgia)
     * - Motivação: 0.10 (desire)
     * - Quebra de expectativa: 0.10 (surprise positiva/negativa)
     * - Estado basal: 0.15 (neutral - threshold alto pois é estado padrão)
     * - Curiosidade: 0.09 (curiosity, anticipation)
     * - Esperança: 0.10 (hope)
     * - Tranquilidade: 0.08 (relief, satisfaction, calmness, contentment)
     * - Interesse: 0.10 (interest)
     * - Incerteza: 0.08 (confusion, doubt)
     * - Baixa energia: 0.10 (boredom)
     */
    mentalState: {
      concentration: 0.10,
      contemplation: 0.10,
      awkwardness: 0.08,
      envy: 0.08,
      pain: 0.12,
      pride: 0.09,
      realization: 0.07,
      nostalgia: 0.10,
      desire: 0.10,
      surprise: 0.10,
      neutral: 0.15,
      // FASE 7: Novas emoções
      curiosity: 0.09,
      anticipation: 0.09,
      hope: 0.10,
      relief: 0.08,
      satisfaction: 0.08,
      calmness: 0.08,
      contentment: 0.08,
      interest: 0.10,
      confusion: 0.08,
      doubt: 0.08,
      boredom: 0.10,
    },
  },

  /**
   * Camada 2: Meta-Estados Emocionais
   * 
   * Detecta padrões emocionais complexos que emergem de combinações
   * de sinais ao longo do tempo.
   */
  metastates: {
    /**
     * Tendência de Frustração Crescente
     * 
     * Detecta quando arousal aumenta enquanto valence diminui,
     * indicando frustração crescente mesmo sem emoção explícita.
     */
    frustrationTrend: {
      /**
       * Aumento mínimo de arousal necessário para detectar frustração.
       * Valores positivos indicam aumento.
       */
      arousalDelta: 0.25,

      /**
       * Queda mínima de valence necessária.
       * Valores negativos indicam queda.
       * Reduzido de -0.2 para -0.15 para detectar mais casos.
       */
      valenceDelta: -0.15,
    },

    /**
     * Efeito Pós-Interrupção
     * 
     * Detecta mudança emocional negativa após uma interrupção,
     * indicando possível desconforto ou frustração.
     */
    postInterruption: {
      /**
       * Queda de valence após interrupção.
       * Reduzido de -0.2 para -0.15 para detectar mais casos.
       */
      valenceDelta: -0.15,

      /**
       * Cobertura mínima de fala necessária para validar o sinal.
       * Usa gate padronizado minSpeechMeta (0.30).
       */
      minCoverage: 0.30,

      /**
       * Janela mínima após interrupção (6 segundos).
       * Não detecta antes deste tempo.
       */
      windowMin: 6000,

      /**
       * Janela máxima após interrupção (30 segundos).
       * Não detecta após este tempo.
       */
      windowMax: 30000,
    },

    /**
     * Polarização Emocional
     * 
     * Detecta quando participantes se dividem em grupos emocionais distintos,
     * indicando possível conflito ou desalinhamento.
     */
    polarization: {
      /**
       * Threshold de valence negativo para grupo negativo.
       */
      valenceNegative: -0.2,

      /**
       * Threshold de valence positivo para grupo positivo.
       */
      valencePositive: 0.2,

      /**
       * Diferença mínima entre grupos para considerar polarização.
       * Reduzido de 0.5 para 0.4 para detectar mais casos.
       */
      difference: 0.4,

      /**
       * Número mínimo de participantes necessários para detectar polarização.
       */
      minParticipants: 3,
    },
  },

  /**
   * Camada 3: Sinais Prosódicos
   * 
   * Detecta características acústicas e prosódicas da fala,
   * independentemente de emoções específicas.
   */
  prosody: {
    /**
     * Volume (RMS em dBFS)
     * 
     * Detecta volume muito baixo ou muito alto.
     * Valores em dBFS (decibels relative to full scale).
     * Valores mais negativos = mais baixo.
     */
    volume: {
      /**
       * Volume baixo (warning).
       * Abaixo de -28 dBFS é considerado baixo.
       */
      low: -38,

      /**
       * Volume crítico (critical).
       * Abaixo de -34 dBFS é quase inaudível.
       */
      lowCritical: -44,

      /**
       * Volume alto (warning).
       * Acima de -10 dBFS é considerado alto.
       */
      high: -10,

      /**
       * Volume crítico alto (critical).
       * Acima de -6 dBFS pode estar clipando.
       */
      highCritical: -6,
    },

    /**
     * Arousal (Ativação/Energia)
     * 
     * Mede o nível de ativação/energia na voz.
     * Valores normalizados: -1 (muito baixo) a +1 (muito alto).
     */
    arousal: {
      /**
       * Arousal baixo (warning).
       * Indica voz desanimada ou sem energia.
       */
      low: -0.4,

      /**
       * Arousal baixo (info).
       * Indica energia um pouco baixa.
       */
      lowInfo: -0.2,

      /**
       * Arousal alto (info).
       * Indica entusiasmo ou energia alta.
       */
      high: 0.5,

      /**
       * Arousal muito alto (warning).
       * Indica energia excessiva que pode precisar ser canalizada.
       */
      highWarning: 0.7,
    },

    /**
     * Valence (Valência Emocional)
     * 
     * Mede a positividade/negatividade emocional.
     * Valores normalizados: -1 (muito negativo) a +1 (muito positivo).
     */
    valence: {
      /**
       * Valence negativo severo (warning).
       * Indica tom muito negativo.
       */
      negativeSevere: -0.6,

      /**
       * Valence negativo (info).
       * Indica tendência negativa perceptível.
       */
      negativeInfo: -0.35,
    },

    /**
     * Monotonia Prosódica
     * 
     * Detecta falta de variação na entonação.
     * Medido através do desvio padrão do arousal.
     */
    monotony: {
      /**
       * Desvio padrão baixo (warning).
       * Indica fala muito monótona.
       */
      stdevWarning: 0.06,

      /**
       * Desvio padrão baixo (info).
       * Indica pouca variação de entonação.
       */
      stdevInfo: 0.1,
    },

    /**
     * Ritmo da Fala
     * 
     * Detecta ritmo acelerado ou pausado.
     */
    pace: {
      /**
       * Ritmo Acelerado
       */
      accelerated: {
        /**
         * Número mínimo de alternâncias fala/silêncio por segundo.
         */
        switchesPerSec: 1.0,

        /**
         * Número mínimo de segmentos de fala necessários.
         */
        minSegments: 6,

        /**
         * Threshold para warning (ritmo muito acelerado).
         */
        warningThreshold: 1.5,
      },

      /**
       * Ritmo Pausado
       */
      paused: {
        /**
         * Silêncio mais longo permitido em segundos (info).
         */
        longestSilence: 5.0,

        /**
         * Threshold para warning (pausas muito longas).
         */
        warningThreshold: 7.0,

        /**
         * Cobertura mínima de fala necessária.
         */
        minCoverage: 0.10,
      },
    },

    /**
     * Energia do Grupo
     * 
     * Mede o arousal médio de todos os participantes (exceto host).
     */
    groupEnergy: {
      /**
       * Energia baixa (info).
       */
      low: -0.3,

      /**
       * Energia muito baixa (warning).
       */
      lowWarning: -0.5,
    },
  },

  /**
   * Camada 4: Estados de Longo Prazo
   * 
   * Detecta padrões comportamentais que emergem ao longo de períodos
   * mais longos (minutos).
   */
  longterm: {
    /**
     * Silêncio Prolongado
     * 
     * Detecta quando um participante fica muito tempo sem falar.
     */
    silence: {
      /**
       * Janela temporal em milissegundos (60 segundos).
       */
      windowMs: 60000,

      /**
       * Cobertura máxima de fala para considerar silêncio (< 5%).
       */
      speechCoverage: 0.05,

      /**
       * Threshold de RMS para considerar silêncio (muito baixo).
       */
      rmsThreshold: -50,

      /**
       * Número mínimo de amostras necessárias.
       * Aumentado de 10 para 20 para melhorar confiabilidade (longo prazo).
       */
      minSamples: 20,
    },

    /**
     * Overlap de Fala
     * 
     * Detecta quando múltiplos participantes falam simultaneamente.
     */
    overlap: {
      /**
       * Número mínimo de participantes falando simultaneamente.
       */
      minParticipants: 2,

      /**
       * Cobertura mínima de overlap necessária.
       * Reduzido de 0.20 para 0.15 para detectar mais casos.
       * Usa gate padronizado minSpeechLongTerm (0.20) para validação individual.
       */
      minCoverage: 0.15,
    },

    /**
     * Interrupções Frequentes
     * 
     * Detecta quando há muitas interrupções em um período.
     */
    interruptions: {
      /**
       * Janela temporal em milissegundos (60 segundos).
       */
      windowMs: 60000,

      /**
       * Número mínimo de interrupções para considerar frequente.
       * Reduzido de 5 para 3 para detectar mais casos.
       */
      minCount: 3,

      /**
       * Throttle mínimo entre interrupções (2 segundos).
       */
      throttleMs: 2000,
    },

    /**
     * Monólogo Prolongado
     * 
     * Detecta quando um participante domina a conversa.
     */
    monologue: {
      /**
       * Janela temporal em milissegundos (60 segundos).
       */
      windowMs: 60000,

      /**
       * Razão mínima de dominância (≥80%).
       */
      dominanceRatio: 0.8,

      /**
       * Número mínimo de eventos de fala necessários.
       */
      minSpeechEvents: 10,
    },
  },

  /**
   * Gates de Cobertura de Fala
   * 
   * Define a cobertura mínima de fala necessária para cada tipo de detecção.
   * Valores entre 0 e 1, onde 1 = 100% de cobertura.
   * 
   * Estes gates previnem falsos positivos quando há pouco ou nenhum áudio.
   * 
   * ETAPA 2: Gates reduzidos de forma balanceada para permitir detecções em reuniões
   * com pausas naturais, mantendo proteção mínima contra ruído/silêncio.
   * 
   * Gates padronizados por camada para criar consistência:
   * - Camada 1 (Primárias): 18% (reduzido de 25%) - detecções emocionais diretas
   * - Camada 2 (Meta-estados): 22% (reduzido de 30%) - padrões emocionais complexos
   * - Camada 3 (Prosódicos): 30% (reduzido de 40%) - características acústicas
   * - Volume: 35% (reduzido de 50%) - problema técnico que precisa de mais dados
   * - Camada 4 (Longo prazo): 15% (reduzido de 20%) - padrões comportamentais
   */
  gates: {
    /**
     * Cobertura mínima para Camada 1: Emoções Primárias (18%).
     * Reduzido de 25% para 18% (ETAPA 2) - redução moderada, ainda protege contra ruído.
     * Usado por: hostilidade, frustração, tédio, confusão, engajamento
     */
    minSpeechPrimary: 0.18,

    /**
     * Cobertura mínima para Camada 2: Meta-Estados Emocionais (22%).
     * Reduzido de 30% para 22% (ETAPA 2) - redução moderada, padrões complexos precisam mais fala.
     * Usado por: frustração trend, pós-interrupção, polarização, energia do grupo
     */
    minSpeechMeta: 0.22,

    /**
     * Cobertura mínima para Camada 3: Sinais Prosódicos (30%).
     * Reduzido de 40% para 30% (ETAPA 2) - redução moderada, características acústicas precisam mais fala.
     * Usado por: arousal, valence, monotonia, ritmo
     */
    minSpeechProsodic: 0.30,

    /**
     * Cobertura mínima para Volume (35%).
     * Reduzido de 50% para 35% (ETAPA 2) - redução maior (era muito restritivo), mas ainda protege.
     * Volume é um problema técnico que precisa de mais dados para análise confiável.
     */
    minSpeechProsodicVolume: 0.35,

    /**
     * Cobertura mínima para Camada 4: Estados de Longo Prazo (15%).
     * Reduzido de 20% para 15% (ETAPA 2) - redução pequena, padrões comportamentais podem ter menos fala.
     * Usado por: silêncio, overlap, interrupções
     */
    minSpeechLongTerm: 0.15,
  },

  /**
   * Cooldowns (em milissegundos)
   * 
   * Define períodos de espera entre detecções do mesmo tipo,
   * prevenindo spam de feedbacks repetitivos.
   */
  cooldowns: {
    /**
     * Cooldown geral para emoções primárias (90 segundos).
     */
    primary: 90_000,

    /**
     * Cooldown para meta-estados (45 segundos).
     */
    metastates: 45_000,

    /**
     * Cooldown para detecção de volume (15 segundos).
     * ETAPA 8: Reduzido de 20s para 15s - volume pode mudar rápido, redução moderada ainda protege.
     */
    volume: 15_000,

    /**
     * Cooldown para detecção de arousal (20 segundos).
     * ETAPA 8: Reduzido de 25s para 20s - arousal pode mudar, redução moderada ainda protege.
     */
    arousal: 20_000,

    /**
     * Cooldown para ritmo pausado (30 segundos).
     */
    slowPace: 30_000,

    /**
     * Cooldown para silêncio prolongado (120 segundos).
     */
    silence: 120_000,

    /**
     * Cooldown para interrupções frequentes (90 segundos).
     */
    interruptions: 90_000,

    /**
     * Cooldowns específicos por tipo de emoção primária.
     */
    primaryEmotion: {
      hostility: 30_000,
      boredom: 25_000,
      frustration: 25_000,
      /**
       * Cooldown para confusão (25 segundos).
       * ETAPA 8: Reduzido de 30s para 25s - redução pequena, ainda protege contra spam.
       */
      confusion: 25_000,
      positiveEngagement: 60_000, // Mais longo para evitar spam de elogios
      /**
       * FASE 1: Cooldowns para novos detectores.
       * Serenidade: 90s (mais longo, não é urgente)
       * Conexão: 75s (moderado, positivo mas não crítico)
       * Tristeza: 40s (moderado-alto, requer atenção mas não é urgente como hostilidade)
       * Estado Mental: 60s (moderado, estados contextuais variados)
       */
      serenity: 90_000,
      connection: 75_000,
      sadness: 40_000,
      mentalState: 60_000,
    },

    /**
     * Cooldowns específicos por tipo de meta-estado.
     */
    meta: {
      frustrationTrend: 25_000,
      postInterruption: 25_000,
      polarization: 45_000,
    },

    /**
     * Cooldowns específicos por tipo de sinal prosódico.
     */
    prosodic: {
      /**
       * Cooldown para volume (15 segundos).
       * ETAPA 8: Reduzido de 20s para 15s - volume pode mudar rápido, redução moderada ainda protege.
       */
      volume: 15_000,
      monotony: 20_000,
      rhythmAccelerated: 20_000,
      rhythmPaused: 60_000,
      /**
       * Cooldown base para arousal (info).
       * ETAPA 8: Reduzido de 25s para 20s - arousal pode mudar, redução moderada ainda protege.
       */
      arousal: 20_000,
      /**
       * Cooldown para arousal alto warning (20 segundos).
       */
      arousalWarning: 20_000,
      /**
       * Cooldown para arousal baixo warning (20 segundos).
       */
      arousalLowWarning: 20_000,
      /**
       * Cooldown base para valence negativo (info).
       */
      valence: 20_000,
      /**
       * Cooldown para valence negativo severo (25 segundos).
       */
      valenceSevere: 25_000,
      groupEnergy: 30_000,
    },

    /**
     * Cooldowns específicos por tipo de estado de longo prazo.
     */
    longTerm: {
      silence: 30_000,
      /**
       * Cooldown aumentado de 15s para 20s para reduzir spam.
       * Overlap precisa de tempo para se resolver.
       */
      overlap: 20_000,
      interruptions: 30_000,
    },
  },

  /**
   * Janelas Temporais (em milissegundos)
   * 
   * Define os períodos de tempo usados para análise de diferentes sinais.
   * 
   * RELAÇÃO ENTRE JANELA E MÍNIMOS DE AMOSTRAS:
   * 
   * A taxa de amostragem real é ~1 amostra/segundo (baseado em AUDIO_PIPELINE_GROUP_SECONDS=2).
   * Os mínimos de amostras nos detectores são calculados como porcentagem da janela esperada:
   * 
   * - Volume (janela 5s): Mínimo 5 amostras = 50% da janela esperada (~5 amostras)
   *   → Permite detecção precoce de problemas técnicos
   * 
   * - Prosódicos (janela 10s): Mínimo 8 amostras = 80% da janela esperada (~10 amostras)
   *   → Garante dados suficientes para análise acústica confiável
   * 
   * - Primárias (janela 10s): Mínimo 6 amostras = 60% da janela esperada (~10 amostras)
   *   → Permite detecção precoce de emoções, mas com dados suficientes
   * 
   * - Meta-estados (janela 20s): Mínimo 12 amostras = 60% da janela esperada (~20 amostras)
   *   → Padrões complexos precisam de mais contexto temporal
   * 
   * - Longo prazo (janela 30s): Mínimo 15 amostras = 50% da janela esperada (~30 amostras)
   *   → Padrões comportamentais podem ter menos amostras por serem mais longos
   * 
   * IMPORTANTE: Estes mínimos são realistas baseados na taxa de amostragem real.
   * Valores muito altos (ex: 15 amostras em janela de 5s) são impossíveis de atingir.
   */
  windows: {
    /**
     * Janela curta (5 segundos).
     * Usada para detecções imediatas como volume.
     * Aumentada de 3s para 5s para reduzir falsos positivos de volume.
     * 
     * Mínimo de amostras esperado: ~5 amostras (1 amostra/s)
     * Mínimo usado nos detectores: 5 amostras (50% da janela)
     */
    short: 5_000,

    /**
     * Janela longa (10 segundos).
     * Usada para detecções que precisam de mais contexto.
     * 
     * Mínimo de amostras esperado: ~10 amostras (1 amostra/s)
     * Mínimo usado nos detectores:
     *   - Prosódicos: 8 amostras (80% da janela)
     *   - Primárias: 6 amostras (60% da janela)
     */
    long: 10_000,

    /**
     * Janela de tendência (20 segundos).
     * Usada para detectar padrões e tendências.
     * 
     * Mínimo de amostras esperado: ~20 amostras (1 amostra/s)
     * Mínimo usado nos detectores: 12 amostras (60% da janela)
     */
    trend: 20_000,

    /**
     * Horizonte de poda (65 segundos).
     * Amostras mais antigas que isso são removidas da memória.
     */
    prune: 65_000,
  },

  /**
   * Parâmetros de EMA (Exponential Moving Average)
   * 
   * Usado para suavizar valores ao longo do tempo.
   */
  ema: {
    /**
     * Fator alpha do EMA (0.3).
     * Valores mais altos = mais peso para valores recentes.
     * Range: 0 a 1.
     */
    alpha: 0.3,
  },
};

