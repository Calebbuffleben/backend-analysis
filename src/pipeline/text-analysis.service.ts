import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import { EventEmitter2 } from '@nestjs/event-emitter';

export interface TranscriptionChunk {
  meetingId: string;
  participantId: string;
  text: string;
  timestamp: number;
  language?: string;
  confidence?: number;
}

export interface TextAnalysisResult {
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
     * null se nenhuma categoria foi detectada com confiança suficiente ou se SBERT não estiver configurado.
     */
    sales_category?: string | null;
    /**
     * Confiança da classificação de categoria de vendas (0.0 a 1.0).
     * 
     * Calculada baseada na diferença entre a melhor categoria e a segunda melhor,
     * considerando também o score absoluto da melhor categoria.
     * 
     * null se sales_category for null.
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
     * null se sales_category for null.
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
     * null se sales_category for null.
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
     * null se sales_category for null ou se nenhuma flag estiver ativa.
     */
    sales_category_flags?: {
      price_window_open?: boolean;
      decision_signal_strong?: boolean;
      ready_to_close?: boolean;
      indecision_detected?: boolean;
      decision_postponement_signal?: boolean;
      conditional_language_signal?: boolean;
      // (Opcional) Teach-back/reformulação detectada no texto atual
      solution_reformulation_signal?: boolean;
    } | null;
    /**
     * Score absoluto da melhor categoria (0.0 a 1.0).
     * Útil para debug quando sales_category é null por min_confidence.
     */
    sales_category_best_score?: number;
    /**
     * Scores de todas as categorias (debug/diagnóstico).
     */
    sales_category_scores?: Record<string, number>;
    /**
     * Top 3 categorias com scores (debug/diagnóstico).
     */
    sales_category_top_3?: Array<{ category: string; score: number }>;
    /**
     * Agregação temporal de categorias baseada em janela de contexto.
     * 
     * Reduz ruído de frases isoladas calculando categoria dominante
     * e estabilidade ao longo de múltiplos chunks.
     * 
     * null se não houver contexto suficiente ou se SBERT não estiver configurado.
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
     * 
     * Indica mudança significativa de estágio na conversa:
     * - advancing: Cliente progredindo (ex: value_exploration → price_interest)
     * - regressing: Cliente regredindo (ex: decision_signal → objection_soft)
     * - lateral: Mudança sem progressão/regressão clara
     * 
     * null se não houver transição detectada.
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
     * 
     * Indica direção da conversa baseada em sequência de categorias:
     * - advancing: Conversa progredindo positivamente
     * - stable: Sem mudança significativa
     * - regressing: Conversa regredindo
     * 
     * null se não houver contexto suficiente.
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
    /**
     * Marcadores de reformulação/teach-back detectados no texto atual (PT-BR).
     */
    reformulation_markers_detected?: string[];
    /**
     * Score simples (0..1) baseado na presença de marcadores de reformulação.
     */
    reformulation_marker_score?: number;
  };
  /** Origem do resultado: 'buffer' (áudio → Whisper) ou 'egress' (transcription_chunk / legendas). Usado para diagnóstico e política por origem. */
  source?: 'buffer' | 'egress';
  timestamp: number;
  confidence: number;
}

export interface AudioChunkPayload {
  meetingId: string;
  participantId: string;
  track: string;
  audioData: string; // base64 WAV
  sampleRate: number;
  channels: number;
  /**
   * Timestamp of capture/window (ms since epoch), ideally from the audio grouping layer.
   * This is NOT necessarily the server send time.
   */
  timestamp: number;
  /**
   * Backend-side timestamp when the chunk was enqueued/sent (ms since epoch).
   * Useful to split queueing latency vs execution latency.
   */
  serverSendTs?: number;
  language?: string;
  /**
   * Optional sequence number per (meetingId, participantId, track).
   */
  seq?: number;
}

@Injectable()
export class TextAnalysisService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TextAnalysisService.name);
  private socket: Socket | null = null;
  private readonly pythonServiceUrl: string;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts: number;
  private lastPongAtMs: number | null = null;
  private readonly pongTtlMs = 30_000;
  private healthPingInterval: NodeJS.Timeout | null = null;

  constructor(private readonly emitter: EventEmitter2) {
    // FASE 2: Validação de instância única do EventEmitter2
    this.logger.log(`[EVENT_EMITTER] TextAnalysisService received EventEmitter2 instance: ${emitter.constructor.name}`);
    this.logger.debug(`[EVENT_EMITTER] Instance type: ${typeof emitter}, has emit: ${typeof emitter.emit === 'function'}`);
    
    // Socket.IO client adiciona automaticamente /socket.io/ ao conectar
    const rawUrl = process.env.TEXT_ANALYSIS_SERVICE_URL || 'https://text-analysis-production.up.railway.app';

    this.logger.log(`[CONFIG] Raw TEXT_ANALYSIS_SERVICE_URL: ${rawUrl}`);

    // Defensive: prevent misconfig such as ".../socket.io" or ".../socket.io/" (we set path separately)
    this.pythonServiceUrl = rawUrl
      .trim()
      .replace(/\/socket\.io\/?$/i, '')
      .replace(/\/+$/g, '');

    this.logger.log(`[CONFIG] Cleaned pythonServiceUrl: ${this.pythonServiceUrl}`);

    const rawMaxReconnectAttempts = process.env.TEXT_ANALYSIS_MAX_RECONNECT_ATTEMPTS;
    const parsedMaxReconnectAttempts =
      rawMaxReconnectAttempts !== undefined ? Number(rawMaxReconnectAttempts) : Number.POSITIVE_INFINITY;
    this.maxReconnectAttempts =
      Number.isFinite(parsedMaxReconnectAttempts) && parsedMaxReconnectAttempts > 0
        ? parsedMaxReconnectAttempts
        : Number.POSITIVE_INFINITY;
    
    this.logger.log(
      `TextAnalysisService initialized. Will connect to: ${this.pythonServiceUrl} (maxReconnectAttempts=${this.maxReconnectAttempts === Number.POSITIVE_INFINITY ? 'Infinity' : this.maxReconnectAttempts})`,
    );
  }

  async onApplicationBootstrap() {
    const queueEnabled = (process.env.DEEP_QUEUE_ENABLED || 'false') === 'true';
    
    if (queueEnabled) {
      this.logger.log(
        '✅ [MODE] Deep Queue enabled - using Redis Streams for audio processing',
        {
          mode: 'DEEP_QUEUE',
          audio_stream: process.env.DEEP_AUDIO_STREAM_KEY || 'deep:audio_jobs',
          results_stream: process.env.DEEP_RESULTS_STREAM_KEY || 'deep:text_results',
          socket_io_connection: 'NOT USED',
          note: 'Backend will NOT connect to Python via Socket.IO. Communication is 100% via Redis.',
        },
      );
      return;
    }
    
    this.logger.log(
      '✅ [MODE] Socket.IO mode - connecting directly to Python service',
      {
        mode: 'SOCKET_IO',
        url: this.pythonServiceUrl,
        note: 'Backend will establish Socket.IO connection for bidirectional communication',
      }
    );
    this.logger.log(`[LIFECYCLE] All modules initialized, handlers @OnEvent registered - safe to connect and emit events`);
    
    await this.connect();
  }

  async onApplicationShutdown() {
    this.disconnect();
  }

  async connect(): Promise<void> {
    this.logger.log(`🔄 [CONNECT] Attempting to connect to Python service...`);
    this.logger.log(`[CONNECT] Current socket state: exists=${!!this.socket}, connected=${this.socket?.connected ?? false}`);

    if (this.socket?.connected) {
      this.logger.log('✅ [CONNECT] Already connected to Python service');
      return;
    }

    // Se já existe um socket, limpar completamente
    if (this.socket) {
      this.logger.log(`[CONNECT] Cleaning up existing socket...`);
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    // Log crítico para garantir visibilidade
    this.logger.log(`🔌 [CONNECTION] Connecting to Python text analysis service: ${this.pythonServiceUrl}`);
    this.logger.log(`[CONNECTION] Socket.IO will attempt connection with transports: websocket, polling`);
    this.logger.log(`[CONNECTION] Reconnection enabled: true, max attempts: ${this.maxReconnectAttempts === Number.POSITIVE_INFINITY ? '∞' : this.maxReconnectAttempts}`);

    try {
      // Configuração original que funcionava: apenas WebSocket
      this.socket = io(this.pythonServiceUrl, {
        transports: ['websocket'], // Apenas WebSocket (como estava funcionando antes)
        reconnection: true,
        reconnectionDelay: 1000, // Delay original
        reconnectionAttempts: this.maxReconnectAttempts,
      });
    } catch (error) {
      this.logger.error(
        `❌ Failed to create Socket.IO client: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    this.socket.on('connect', () => {
      this.logger.log('✅ Connected to Python text analysis service');
      this.logger.log(`Socket ID: ${this.socket?.id}, Connected: ${this.socket?.connected}`);
      this.reconnectAttempts = 0;

      // Handshake de saúde (eventos customizados para evitar colisão com heartbeat interno)
      this.startHealthPingLoop();
    });

    // Listener para reconexão bem-sucedida
    this.socket.on('reconnect', (attemptNumber: number) => {
      this.logger.log(`🔄 Reconnected to Python service after ${attemptNumber} attempts`);
      this.reconnectAttempts = 0;
      this.startHealthPingLoop();
    });

    // Listener para tentativas de reconexão
    this.socket.on('reconnect_attempt', (attemptNumber: number) => {
      this.logger.warn(`🔄 Attempting to reconnect to Python service (attempt ${attemptNumber})`);
    });

    // Listener para falha na reconexão
    this.socket.on('reconnect_failed', () => {
      this.logger.error('❌ [CRITICAL] Failed to reconnect to Python service after all attempts');
    });

    const onAnyPong = (label: 'pong' | 'health_pong') => (data: { timestamp?: number; service?: string }) => {
      this.lastPongAtMs = Date.now();
      this.logger.log(
        `🏓 Received ${label} from ${data?.service ?? 'unknown'} (ts=${data?.timestamp ?? 'N/A'})`,
      );
    };

    // Backwards-compat (if server emits 'pong')
    this.socket.on('pong', onAnyPong('pong'));
    // Preferred (our custom health channel)
    this.socket.on('health_pong', onAnyPong('health_pong'));

    this.socket.on('text_analysis_result', (data: TextAnalysisResult) => {
      // Log básico da recepção
      this.logger.log(
        `Received text analysis result: ${data.meetingId}/${data.participantId}`,
      );
      
      // Log detalhado de sales_category se presente
      if (data.analysis.sales_category) {
        const flagsInfo = data.analysis.sales_category_flags
          ? Object.entries(data.analysis.sales_category_flags)
              .filter(([, value]) => value === true)
              .map(([key]) => key)
              .join(', ')
          : '';
        const flagsText = flagsInfo ? ` [Flags: ${flagsInfo}]` : '';
        
        // Adicionar informações de contexto se disponíveis
        const transitionInfo = data.analysis.sales_category_transition
          ? ` [Transition: ${data.analysis.sales_category_transition.transition_type} ${data.analysis.sales_category_transition.from_category}→${data.analysis.sales_category_transition.to_category}]`
          : '';
        const trendInfo = data.analysis.sales_category_trend
          ? ` [Trend: ${data.analysis.sales_category_trend.trend}]`
          : '';
        
        this.logger.log(
          `💼 Sales category detected: ${data.analysis.sales_category} (conf: ${data.analysis.sales_category_confidence?.toFixed(2) ?? 'N/A'}, intensity: ${data.analysis.sales_category_intensity?.toFixed(2) ?? 'N/A'}, ambiguity: ${data.analysis.sales_category_ambiguity?.toFixed(2) ?? 'N/A'})${flagsText}${transitionInfo}${trendInfo}`,
          {
            meetingId: data.meetingId,
            participantId: data.participantId,
            sales_category: data.analysis.sales_category,
            sales_category_confidence: data.analysis.sales_category_confidence,
            text_preview: data.text.substring(0, 50),
            sentiment: data.analysis.sentiment,
            intent: data.analysis.intent,
          },
        );
      } else {
        // Log quando sales_category não está presente (pode ser normal se SBERT não estiver configurado)
        this.logger.debug(
          `No sales category detected for ${data.meetingId}/${data.participantId}`,
          {
            meetingId: data.meetingId,
            participantId: data.participantId,
            text_preview: data.text.substring(0, 50),
          },
        );
      }
      
      // FASE 2: Validação - logar listeners registrados antes de emitir
      const listenersCount = this.emitter.listenerCount('text.analysis');
      this.logger.debug(`[EVENT_EMITTER] About to emit 'text.analysis'. Listeners count: ${listenersCount}`);
      
      // Emitir evento para integração com A2E2
      this.emitter.emit('text.analysis', data);
    });

    this.socket.on('error', (error: Error) => {
      this.logger.error(`Python service error: ${error.message}`, {
        url: this.pythonServiceUrl,
        errorType: error.constructor.name,
        stack: error.stack,
      });
    });

    this.socket.on('disconnect', (reason: string) => {
      this.logger.warn(`Disconnected from Python service: ${reason}`, {
        url: this.pythonServiceUrl,
        reason,
      });
      this.lastPongAtMs = null;
      this.stopHealthPingLoop();
    });

    this.socket.on('connect_error', (error: Error) => {
      this.reconnectAttempts++;
      // Log crítico para garantir visibilidade em produção
      this.logger.error(
        `❌ [CRITICAL] Failed to connect to Python service (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts === Number.POSITIVE_INFINITY ? '∞' : this.maxReconnectAttempts}): ${error.message}`,
      );
      this.logger.error(`[DIAGNOSTIC] Connection error details:`, {
        url: this.pythonServiceUrl,
        errorType: error.constructor.name,
        errorMessage: error.message,
        errorName: error.name,
        stack: error.stack,
        reconnectAttempts: this.reconnectAttempts,
        maxReconnectAttempts: this.maxReconnectAttempts,
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.logger.log('Disconnected from Python text analysis service');
    }
  }

  // TODO: (Flow) Pre-transcribed text ingestion (`/egress-transcription` → `transcription_chunk`) is not used in the current main pipeline (audio → Whisper). Kept as an optional fallback.
  async sendTranscription(chunk: TranscriptionChunk): Promise<void> {
    if (!this.socket?.connected) {
      this.logger.warn('Python service not connected, skipping transcription');
      return;
    }

    try {
      this.socket.emit('transcription_chunk', {
        meetingId: chunk.meetingId,
        participantId: chunk.participantId,
        text: chunk.text,
        timestamp: chunk.timestamp,
        language: chunk.language,
        confidence: chunk.confidence,
      });
      this.logger.debug(
        `Sent transcription to Python: ${chunk.meetingId}/${chunk.participantId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send transcription: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async sendAudioChunk(
    meetingId: string,
    participantId: string,
    track: string,
    wavData: Buffer,
    sampleRate: number,
    channels: number,
    timestamp?: number,
    language?: string,
    seq?: number,
  ): Promise<void> {
    /**
     * Envia chunk de áudio WAV para transcrição no serviço Python.
     * 
     * O áudio será transcrito usando Whisper e depois analisado com BERT.
     * 
     * @param meetingId - ID da reunião
     * @param participantId - ID do participante
     * @param track - ID da track de áudio
     * @param wavData - Dados WAV (incluindo header)
     * @param sampleRate - Taxa de amostragem (Hz)
     * @param channels - Número de canais (1 = mono, 2 = estéreo)
     * @param timestamp - Timestamp opcional
     * @param language - Idioma opcional ('pt' para português)
     */
    if (!this.socket?.connected) {
      this.logger.warn(
        `Python service not connected, skipping audio transcription. Socket exists: ${!!this.socket}, Connected: ${this.socket?.connected}`,
      );
      return;
    }

    try {
      // Converter Buffer para base64 para envio via Socket.IO
      const audioBase64 = wavData.toString('base64');
      const base64Size = audioBase64.length;

      this.logger.log(
        `Sending audio chunk to Python: ${meetingId}/${participantId}/${track} (${wavData.length} bytes WAV, ${base64Size} bytes base64, ${sampleRate}Hz, ${channels}ch)`,
      );

      const payload = {
        meetingId,
        participantId,
        track,
        audioData: audioBase64,
        sampleRate,
        channels,
        timestamp: timestamp ?? Date.now(),
        serverSendTs: Date.now(),
        language: language ?? 'pt',
        seq,
      } satisfies AudioChunkPayload;

      this.logger.debug(
        `[DIAGNOSTIC] About to emit audio_chunk event. Socket connected: ${this.socket?.connected}, Socket exists: ${!!this.socket}`,
      );

      this.socket.emit('audio_chunk', payload);
      
      this.logger.debug(
        `✅ Audio chunk sent to Python for transcription: ${meetingId}/${participantId}/${track} (${wavData.length} bytes WAV, ${base64Size} bytes base64)`,
      );
    } catch (error) {
      this.logger.error(
        `❌ Failed to send audio chunk: ${error instanceof Error ? error.message : String(error)}`,
        {
          errorType: error instanceof Error ? error.constructor.name : typeof error,
          stack: error instanceof Error ? error.stack : undefined,
          meetingId,
          participantId,
        },
      );
    }
  }

  /**
   * Force reconnection to Python service
   * Useful for manual reconnection when connection is lost
   */
  async forceReconnect(): Promise<void> {
    this.logger.log('🔄 Force reconnection requested');
    await this.connect();
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  isHealthy(): boolean {
    if (!this.socket?.connected) return false;
    if (this.lastPongAtMs === null) return false;
    return Date.now() - this.lastPongAtMs <= this.pongTtlMs;
  }

  private startHealthPingLoop(): void {
    this.stopHealthPingLoop();
    const send = () => {
      try {
        const ts = Date.now();
        this.socket?.emit('health_ping', { timestamp: ts });
        this.logger.debug(`🏓 Sent health_ping (ts=${ts})`);
      } catch (e) {
        this.logger.warn(
          `Failed to send health_ping to Python service: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    };
    // Send immediately, then keep-alive
    send();
    this.healthPingInterval = setInterval(send, 10_000);
  }

  private stopHealthPingLoop(): void {
    if (this.healthPingInterval) {
      clearInterval(this.healthPingInterval);
      this.healthPingInterval = null;
    }
  }
}

