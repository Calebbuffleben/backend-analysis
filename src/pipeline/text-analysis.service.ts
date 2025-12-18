import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
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
    } | null;
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
  };
  timestamp: number;
  confidence: number;
}

@Injectable()
export class TextAnalysisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TextAnalysisService.name);
  private socket: Socket | null = null;
  private readonly pythonServiceUrl: string;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;

  constructor(private readonly emitter: EventEmitter2) {
    // Socket.IO client adiciona automaticamente /socket.io/ ao conectar
    this.pythonServiceUrl =
      process.env.TEXT_ANALYSIS_SERVICE_URL || 'http://localhost:8001';
    
    this.logger.log(
      `TextAnalysisService initialized. Will connect to: ${this.pythonServiceUrl}`,
    );
  }

  async onModuleInit() {
    this.logger.log('🚀 TextAnalysisService onModuleInit called, attempting to connect...');
    await this.connect();
  }

  async onModuleDestroy() {
    this.disconnect();
  }

  async connect(): Promise<void> {
    if (this.socket?.connected) {
      this.logger.debug('Already connected to Python service');
      return;
    }

    this.logger.log(`🔌 Connecting to Python text analysis service: ${this.pythonServiceUrl}`);

    try {
      this.socket = io(this.pythonServiceUrl, {
        transports: ['polling', 'websocket'], // Permite polling primeiro, depois upgrade para WebSocket
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: this.maxReconnectAttempts,
        timeout: 10000, // Aumentado para 10s para conexões mais lentas
        forceNew: false,
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
    });

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
      
      // Emitir evento para integração com A2E2
      this.emitter.emit('text.analysis', data);
    });

    this.socket.on('error', (error: Error) => {
      this.logger.error(`Python service error: ${error.message}`);
    });

    this.socket.on('disconnect', (reason: string) => {
      this.logger.warn(`Disconnected from Python service: ${reason}`);
    });

    this.socket.on('connect_error', (error: Error) => {
      this.reconnectAttempts++;
      this.logger.warn(
        `Failed to connect to Python service (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}): ${error.message}`,
      );
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.logger.log('Disconnected from Python text analysis service');
    }
  }

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

      this.logger.log(
        `Sending audio chunk to Python: ${meetingId}/${participantId}/${track} (${wavData.length} bytes, ${sampleRate}Hz, ${channels}ch)`,
      );

      this.socket.emit('audio_chunk', {
        meetingId,
        participantId,
        track,
        audioData: audioBase64,
        sampleRate,
        channels,
        timestamp: timestamp ?? Date.now(),
        language: language ?? 'pt',
      });
      
      this.logger.debug(
        `✅ Audio chunk sent to Python for transcription: ${meetingId}/${participantId}/${track} (${wavData.length} bytes)`,
      );
    } catch (error) {
      this.logger.error(
        `❌ Failed to send audio chunk: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}

