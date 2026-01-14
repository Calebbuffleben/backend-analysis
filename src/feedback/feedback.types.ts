export type ParticipantRole = 'host' | 'guest' | 'unknown';

export interface FeedbackIngestionEvent {
  version: 1;
  meetingId: string;
  roomName?: string;
  trackSid?: string;
  participantId?: string;
  participantRole: ParticipantRole;
  ts: number; // ms epoch at ingestion
  prosody: {
    speechDetected: boolean;
    valence?: number;
    arousal?: number;
    emotions?: Record<string, number>; // Map of specific emotion scores (0..1)
    warnings: string[];
  };
  signal?: {
    rmsDbfs?: number;
  };
  debug: {
    rawPreview: string;
    rawHash: string; // sha256 hex
  };
}

export interface AggregatedWindowEvent {
  meetingId: string;
  participantId: string;
  window: { start: number; end: number };
  metrics: {
    speechCoverage: number; // 0..1
    meanRmsDbfs?: number;
    valenceEMA?: number;
    arousalEMA?: number;
  };
}

export type FeedbackSeverity = 'info' | 'warning' | 'critical';

export interface FeedbackEventPayload {
  id: string;
  type:
    | 'volume_baixo'
    | 'volume_alto'
    | 'silencio_prolongado'
    | 'tendencia_emocional_negativa'
    | 'engajamento_baixo'
    | 'overlap_fala'
    | 'monologo_prolongado'
    | 'frustracao_crescente'
    | 'entusiasmo_alto'
    | 'monotonia_prosodica'
    | 'energia_grupo_baixa'
    | 'interrupcoes_frequentes'
    | 'polarizacao_emocional'
    | 'efeito_pos_interrupcao'
    | 'ritmo_acelerado'
    | 'ritmo_pausado'
    | 'hostilidade'
    | 'tedio'
    | 'confusao'
    | 'serenidade'
    | 'conexao'
    | 'tristeza'
    | 'estado_mental'
    | 'sales_price_window_open'
    | 'sales_decision_signal'
    | 'sales_ready_to_close'
    | 'sales_objection_escalating'
    | 'sales_conversation_stalling'
    | 'sales_category_transition'
    | 'sales_client_indecision'
    | 'sales_solution_understood';
  severity: FeedbackSeverity;
  ts: number;
  meetingId: string;
  participantId: string;
  participantName?: string;
  window: { start: number; end: number };
  message: string;
  tips?: string[];
  metadata?: {
    rmsDbfs?: number;
    speechCoverage?: number;
    valenceEMA?: number;
    arousalEMA?: number;
    // Campos específicos para feedbacks de vendas
    sales_category?: string;
    sales_category_confidence?: number;
    sales_category_intensity?: number;
    current_stage?: number;
    from_category?: string;
    to_category?: string;
    transition_confidence?: number;
    stage_difference?: number;
    trend_strength?: number;
    // Campos específicos para detecção de indecisão do cliente
    confidence?: number;
    semantic_patterns_detected?: string[];
    representative_phrases?: string[];
    temporal_consistency?: boolean;
    /**
     * Métricas semânticas de indecisão vindas do serviço Python (quando disponíveis).
     *
     * Útil para debug no frontend e para explicar por que o feedback disparou.
     */
    indecision_metrics?: {
      indecision_score?: number;
      postponement_likelihood?: number;
      conditional_language_score?: number;
    };
    /**
     * Keywords/fra ses condicionais detectadas no texto (serviço Python).
     */
    conditional_keywords_detected?: string[];
    sales_category_aggregated?: {
      dominant_category?: string;
      category_distribution?: Record<string, number>;
      stability?: number;
      total_chunks?: number;
      chunks_with_category?: number;
    };
    // Campos específicos para detecção de "solução foi compreendida" (reformulação)
    similarity_raw?: number;
    markers_detected?: string[];
    keyword_overlap?: number;
    solution_context_excerpt?: string;
    client_reformulation_excerpt?: string;
  };
}

export interface TextAnalysisEvent {
  meetingId: string;
  participantId: string;
  text: string;
  analysis: {
    intent: string;
    intent_confidence: number;
    topic: string;
    topic_confidence: number;
    speech_act: string;
    speech_act_confidence: number;
    keywords: string[];
    entities: string[];
    sentiment: string;
    sentiment_score: number;
    urgency: number;
    embedding: number[];
    /**
     * Categoria de vendas detectada usando análise semântica com SBERT.
     * 
     * Categorias possíveis:
     * - 'price_interest': Cliente demonstra interesse em saber o preço
     * - 'value_exploration': Cliente explora o valor e benefícios da solução
     * - 'objection_soft': Objeções leves, dúvidas ou hesitações
     * - 'objection_hard': Objeções fortes e definitivas, rejeição clara
     * - 'decision_signal': Sinais claros de que o cliente está pronto para decidir
     * - 'information_gathering': Cliente busca informações adicionais
     * - 'stalling': Cliente está protelando ou adiando a decisão
     * - 'closing_readiness': Cliente demonstra prontidão para fechar o negócio
     * 
     * undefined se nenhuma categoria foi detectada com confiança suficiente ou se SBERT não estiver configurado.
     */
    sales_category?: string | null;
    /**
     * Confiança da classificação de categoria de vendas (0.0 a 1.0).
     * 
     * Calculada baseada na diferença entre a melhor categoria e a segunda melhor,
     * considerando também o score absoluto da melhor categoria.
     * 
     * undefined se sales_category for undefined/null.
     */
    sales_category_confidence?: number | null;
    /**
     * Intensidade do sinal semântico (0.0 a 1.0).
     * 
     * Score absoluto da melhor categoria, diferente de confiança.
     * Representa quão forte é o match semântico, independente da diferença
     * entre categorias. Útil para diferenciar entre match fraco mas claro
     * vs match forte.
     * 
     * undefined se sales_category for undefined/null.
     */
    sales_category_intensity?: number | null;
    /**
     * Ambiguidade semântica (0.0 a 1.0).
     * 
     * 0.0 = claro (uma categoria dominante)
     * 1.0 = muito ambíguo (scores muito próximos entre categorias)
     * 
     * Calculado usando entropia normalizada dos scores.
     * Textos ambíguos podem ter múltiplas interpretações válidas.
     * 
     * undefined se sales_category for undefined/null.
     */
    sales_category_ambiguity?: number | null;
    /**
     * Flags semânticas booleanas que facilitam heurísticas no backend.
     * 
     * Flags disponíveis:
     * - price_window_open: True se há janela de oportunidade para falar sobre preço
     * - decision_signal_strong: True se há sinal forte de que cliente está pronto para decidir
     * - ready_to_close: True se cliente demonstra prontidão para fechar o negócio
     * - indecision_detected: True se há sinais de indecisão no texto atual
     * - decision_postponement_signal: True se cliente está postergando decisão
     * - conditional_language_signal: True se há uso de linguagem condicional/aberta
     * 
     * undefined se sales_category for undefined/null ou se nenhuma flag estiver ativa.
     */
    sales_category_flags?: {
      price_window_open?: boolean;
      decision_signal_strong?: boolean;
      ready_to_close?: boolean;
      indecision_detected?: boolean;
      decision_postponement_signal?: boolean;
      conditional_language_signal?: boolean;
    } | null;
    /**
     * Agregação temporal de categorias baseada em janela de contexto.
     */
    sales_category_aggregated?: {
      dominant_category?: string;
      category_distribution?: Record<string, number>;
      stability?: number;
      total_chunks?: number;
      chunks_with_category?: number;
    } | null;
    /**
     * Transição de categoria detectada baseada em histórico.
     */
    sales_category_transition?: {
      transition_type?: 'advancing' | 'regressing' | 'lateral';
      from_category?: string;
      to_category?: string;
      confidence?: number;
      time_delta_ms?: number;
      from_stage?: number;
      to_stage?: number;
      stage_difference?: number;
    } | null;
    /**
     * Tendência semântica da conversa ao longo do tempo.
     */
    sales_category_trend?: {
      trend?: 'advancing' | 'stable' | 'regressing';
      trend_strength?: number;
      current_stage?: number;
      velocity?: number;
    } | null;
    /**
     * Keywords condicionais detectadas no texto.
     * 
     * Lista de palavras e frases que indicam linguagem condicional ou hesitação,
     * característica de clientes indecisos. Exemplos: "talvez", "pensar", "depois",
     * "preciso avaliar", "vou ver", etc.
     * 
     * Array vazio se nenhuma keyword condicional for detectada.
     */
    conditional_keywords_detected?: string[];
    /**
     * Métricas específicas de indecisão pré-calculadas.
     * 
     * Métricas calculadas no Python para facilitar análise no backend:
     * - indecision_score: Score geral de indecisão (0.0 a 1.0)
     * - postponement_likelihood: Probabilidade de postergação de decisão (0.0 a 1.0)
     * - conditional_language_score: Score de linguagem condicional (0.0 a 1.0)
     * 
     * null se métricas não puderem ser calculadas ou se sales_category for null.
     */
    indecision_metrics?: {
      indecision_score?: number;
      postponement_likelihood?: number;
      conditional_language_score?: number;
    } | null;
  };
  timestamp: number;
  confidence: number;
}
