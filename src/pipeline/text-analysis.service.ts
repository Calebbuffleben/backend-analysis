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
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: this.maxReconnectAttempts,
        timeout: 5000,
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
      this.logger.log(
        `Received text analysis result: ${data.meetingId}/${data.participantId}`,
      );
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

