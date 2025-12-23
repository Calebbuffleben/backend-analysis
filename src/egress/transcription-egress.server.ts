import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import type { Socket } from 'net';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { Logger } from '@nestjs/common';
import type { TextAnalysisService } from '../pipeline/text-analysis.service';

const log = new Logger('TranscriptionEgress');

export interface TranscriptionEgressWsOptions {
  path?: string;
}

// TODO: (Flow) This WS endpoint supports pre-transcribed caption ingestion; current main pipeline uses `/egress-audio` + Whisper (Python) for transcription.
export function setupTranscriptionEgressWsServer(
  httpServer: HttpServer,
  opts?: TranscriptionEgressWsOptions,
  textAnalysisService?: TextAnalysisService,
): void {
  const options: Required<TranscriptionEgressWsOptions> = {
    path: opts?.path ?? '/egress-transcription',
  };

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    try {
      const url = request.url ?? '';
      if (!url.startsWith(options.path)) {
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } catch (err) {
      log.error(`Upgrade error: ${(err as Error).message}`);
      socket.destroy();
    }
  });

  function parseUrlParams(req: IncomingMessage): URLSearchParams {
    const url = req.url ?? '';
    const queryString = url.includes('?') ? url.split('?')[1] : '';
    return new URLSearchParams(queryString);
  }

  function sanitize(value: string | null, name: string): string {
    if (!value) return '';
    return value.replace(/[^a-zA-Z0-9_-]/g, '');
  }

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const params = parseUrlParams(req);
    const meetingId = sanitize(params.get('meetingId') ?? '', 'meetingId');
    const participantId = sanitize(params.get('participantId') ?? '', 'participantId');
    const language = params.get('language') ?? 'pt-BR';

    if (!meetingId || !participantId) {
      log.warn('Missing meetingId or participantId, closing connection');
      ws.close(1008, 'Missing required parameters');
      return;
    }

    const id = `${meetingId}/${participantId}`;
    log.log(`Transcription egress connected: ${id}`);

    ws.on('message', async (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      try {
        // Converter dados para string (espera JSON com transcrição)
        let text: string;
        if (isBinary) {
          // Se for binário, converter para Buffer primeiro
          let buf: Buffer;
          if (Array.isArray(data)) {
            buf = Buffer.concat(data);
          } else if (data instanceof ArrayBuffer) {
            buf = Buffer.from(data);
          } else if (ArrayBuffer.isView(data)) {
            const view = data as ArrayBufferView;
            buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
          } else {
            buf = data as Buffer;
          }
          text = buf.toString('utf8');
        } else {
          text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        }
        
        const payload = JSON.parse(text) as {
          text: string;
          timestamp?: number;
          confidence?: number;
        };

        if (!payload.text || typeof payload.text !== 'string') {
          log.warn(`Invalid transcription payload from ${id}`);
          return;
        }

        const chunk = {
          meetingId,
          participantId,
          text: payload.text,
          timestamp: payload.timestamp ?? Date.now(),
          language,
          confidence: payload.confidence,
        };

        log.debug(`Received transcription: ${id} - "${payload.text.substring(0, 50)}..."`);

        // Enviar para serviço Python
        if (textAnalysisService) {
          await textAnalysisService.sendTranscription(chunk);
        } else {
          log.warn('TextAnalysisService not available');
        }
      } catch (error) {
        log.error(
          `Error processing transcription from ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    ws.on('close', () => {
      log.log(`Transcription egress disconnected: ${id}`);
    });

    ws.on('error', (error: Error) => {
      log.error(`Transcription egress error for ${id}: ${error.message}`);
    });
  });

  log.log(`Transcription egress WebSocket server listening on ${options.path}`);
}

