import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'crypto';
import { ParticipantIndexService } from '../livekit/participant-index.service';
import { FeedbackIngestionEvent } from '../feedback/feedback.types';
// Use runtime require to avoid type constructibility issues across ws versions
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WSRuntime = require('ws');

export type HumeMeta = {
  meetingId: string;
  participant: string;
  track: string;
  sampleRate: number;
  channels: number;
};

type WsClient = {
  send(data: string | Buffer): void;
  on(event: 'open', listener: () => unknown): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => unknown): unknown;
  on(event: 'error', listener: (err: Error) => unknown): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => unknown): unknown;
  close(): void;
};

type Connection = {
  ws: WsClient;
  isOpen: boolean;
  pending: Array<string>;
  configured: boolean;
};

@Injectable()
export class HumeStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(HumeStreamService.name);
  private readonly wsUrl: string;
  private readonly wsHeaders: Record<string, string>;
  private keyToConn = new Map<string, Connection>();

  constructor(
    @Inject('HUME_WS_URL') wsUrl: string,
    @Inject('HUME_WS_HEADERS') wsHeaders: Record<string, string>,
    private readonly emitter: EventEmitter2,
    private readonly participantIndex: ParticipantIndexService,
  ) {
    this.wsUrl = wsUrl || 'wss://api.hume.ai/v0/stream/models';
    this.wsHeaders = wsHeaders || {};
  }

  async sendChunk(meta: HumeMeta, wavChunk: Buffer): Promise<void> {
    const key = this.buildKey(meta);
    let conn = this.keyToConn.get(key);
    if (!conn) {
      conn = await this.open(key);
    }
    // Emit local ingestion event with RMS from the WAV chunk (pre-Hume), so volume heuristics work
    try {
      const rmsDbfs = this.computeRmsDbfsFromWav(wavChunk);
      const [meetingId, participant, track] = this.parseKey(key);
      const participantRole = this.participantIndex.getParticipantRole(meetingId, participant);
      const speechDetected = Number.isFinite(rmsDbfs) ? rmsDbfs > -50 : false;
      
      // DEBUG: Log audio level to diagnose "No speech detected" issues (ALWAYS log to debug)
      this.logger.log(`[Hume][AUDIO] RMS: ${rmsDbfs} dBFS (isFinite=${Number.isFinite(rmsDbfs)}, speech=${speechDetected ? 'YES' : 'NO'})`);
      
      const evt: FeedbackIngestionEvent = {
        version: 1,
        meetingId,
        roomName: undefined,
        trackSid: track,
        participantId: participant,
        participantRole,
        ts: Date.now(),
        prosody: {
          speechDetected,
          warnings: [],
        },
        signal: {
          rmsDbfs: Number.isFinite(rmsDbfs) ? rmsDbfs : undefined,
        },
        debug: {
          rawPreview: 'local:rms',
          rawHash: this.sha256(`rms:${rmsDbfs}`),
        },
      };
      this.emitter.emit('feedback.ingestion', evt);
    } catch (e) {
      this.logger.warn(`[Hume][RMS] failed to compute rms: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Always include models with each data payload to satisfy Hume's "models configured" requirement
    const payload = this.buildDataPayload(wavChunk);
    // Debug what we are about to send
    try {
      const info = this.describePayload(payload);
      const b64 = (JSON.parse(payload) as { data?: string }).data ?? '';
      const preview = b64.length > 80 ? `${b64.slice(0, 80)}...` : b64;
      this.logger.log(
        `[Hume][SEND] ${info} wavBytes=${wavChunk.length} base64Len=${b64.length} preview="${preview}"`,
      );
    } catch (_e) {}
    if (!conn.isOpen) {
      conn.pending.push(payload);
      return;
    }
    try {
      conn.ws.send(payload);
      const info = this.describePayload(payload);
      this.logger.log(`[Hume][SENT] ${info} dispatched`);
    } catch (e) {
      const info = this.describePayload(payload);
      this.logger.error(`[Hume][SEND][ERROR] ${info}: ${String(e)}`);
      try {
        conn.ws.close();
      } catch {}
      this.keyToConn.delete(key);
    }
  }

  private async open(key: string): Promise<Connection> {
    const WSClientCtor = WSRuntime as {
      new (
        url: string,
        protocols?: string | string[] | undefined,
        options?: Record<string, unknown>,
      ): WsClient;
    };
    const ws: WsClient = new WSClientCtor(this.wsUrl, undefined, { headers: this.wsHeaders });
    const headerKeys = Object.keys(this.wsHeaders || {});
    const authPresent =
      typeof this.wsHeaders?.['X-Hume-Api-Key'] === 'string' &&
      this.wsHeaders['X-Hume-Api-Key'].length > 0;
    this.logger.log(`[Hume] connecting WS for ${key} → ${this.wsUrl}`);
    this.logger.log(
      `[Hume] headers: keys=[${headerKeys.join(', ')}] auth=${authPresent ? 'present' : 'absent'}`,
    );
    const conn: Connection = { ws, isOpen: false, pending: [], configured: false };
    this.keyToConn.set(key, conn);

    ws.on('open', () => {
      this.logger.log(`[Hume] WS open for ${key}`);
      conn.isOpen = true;
      // Flush any pending payloads (each payload includes models)
      for (const msg of conn.pending.splice(0)) {
        try {
          ws.send(msg);
          const info = this.describePayload(msg);
          this.logger.log(`[Hume][SENT] ${info} dispatched (flush)`);
        } catch (e) {
          const info = this.describePayload(msg);
          this.logger.error(`[Hume][SEND][ERROR] ${info} during flush: ${String(e)}`);
          break;
        }
      }
    });
    ws.on('message', (data: unknown, isBinary: boolean) => {
      void isBinary;
      const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
      const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
      try {
        const obj: unknown = JSON.parse(text);
        const isObj = typeof obj === 'object' && obj !== null;
        // Try to infer status/type and errors
        let type: string | undefined;
        let status: string | number | undefined;
        let errorMsg: string | undefined;
        if (isObj) {
          const anyObj = obj as Record<string, unknown>;
          const t = anyObj['type'];
          if (typeof t === 'string') type = t;
          const s = anyObj['status'] ?? anyObj['code'];
          if (typeof s === 'string' || typeof s === 'number') status = s;
          const e1 = anyObj['error'];
          if (typeof e1 === 'string') errorMsg = e1;
          if (
            !errorMsg &&
            typeof e1 === 'object' &&
            e1 &&
            'message' in (e1 as Record<string, unknown>)
          ) {
            const m = (e1 as Record<string, unknown>)['message'];
            if (typeof m === 'string') errorMsg = m;
          }
          const errs = anyObj['errors'];
          if (!errorMsg && Array.isArray(errs) && errs.length > 0) {
            const first = errs[0];
            if (typeof first === 'string') {
              errorMsg = first;
            } else if (
              first &&
              typeof first === 'object' &&
              'message' in (first as Record<string, unknown>)
            ) {
              const m = (first as Record<string, unknown>)['message'];
              if (typeof m === 'string') errorMsg = m;
            }
          }
          // DIAGNOSTIC: Log ALL responses to see what Hume is returning
          const prosody = anyObj['prosody'];
          const hasProsody = prosody && typeof prosody === 'object';
          
          // Try to extract emotions from the entire response, not just prosody
          const fullExtraction = this.extractEmotionsAndMetrics(anyObj);
          const prosodyExtraction = hasProsody ? this.extractEmotionsAndMetrics(prosody) : null;
          const extraction = prosodyExtraction ?? fullExtraction;
          const { valence, arousal, emotions } = extraction;
          
          // DIAGNOSTIC: Always log what we found
          if (emotions && Object.keys(emotions).length > 0) {
            const top5 = Object.entries(emotions)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([name, score]) => `${name}:${score.toFixed(3)}`)
              .join(', ');
            this.logger.log(`[Hume][EMOTIONS] ✅ Found ${Object.keys(emotions).length} emotions. Top 5: ${top5}, source=${hasProsody ? 'prosody' : 'full'}`);
          } else {
            // Log structure to diagnose why no emotions
            const prosodyKeys = hasProsody ? Object.keys(prosody as Record<string, unknown>) : [];
            const allKeys = Object.keys(anyObj);
            this.logger.warn(
              `[Hume][EMOTIONS] ❌ No emotions found. prosody=${hasProsody}, prosodyKeys=[${prosodyKeys.join(', ')}], allKeys=[${allKeys.join(', ')}], V=${valence?.toFixed(2) ?? 'N/A'}, A=${arousal?.toFixed(2) ?? 'N/A'}`,
            );
          }
          
          if (prosody && typeof prosody === 'object') {
            const warnings: string[] = [];
            let speechDetected = true;
            // Common pattern: { warning: "No speech detected.", code: "W0105" }
            const p = prosody as Record<string, unknown>;
            const warningText = p['warning'];
            const codeText = p['code'];
            if (typeof warningText === 'string') warnings.push(warningText);
            if (typeof codeText === 'string') warnings.push(codeText);
            if (warnings.join(' ').toLowerCase().includes('no speech')) {
              speechDetected = false;
            }
            if (warnings.includes('W0105')) {
              speechDetected = false;
            }

            const [meetingId, participant, track] = this.parseKey(key);
            const participantRole = this.participantIndex.getParticipantRole(
              meetingId,
              participant,
            );
            const evt: FeedbackIngestionEvent = {
              version: 1,
              meetingId,
              roomName: undefined,
              trackSid: track,
              participantId: participant,
              participantRole,
              ts: Date.now(),
              prosody: {
                speechDetected,
                valence,
                arousal,
                emotions,
                warnings,
              },
              debug: {
                rawPreview: preview,
                rawHash: this.sha256(text),
              },
            };
            this.emitter.emit('feedback.ingestion', evt);
          } else if (emotions && Object.keys(emotions).length > 0) {
            // Emit event even if no prosody object, but we found emotions elsewhere
            const [meetingId, participant, track] = this.parseKey(key);
            const participantRole = this.participantIndex.getParticipantRole(
              meetingId,
              participant,
            );
            const evt: FeedbackIngestionEvent = {
              version: 1,
              meetingId,
              roomName: undefined,
              trackSid: track,
              participantId: participant,
              participantRole,
              ts: Date.now(),
              prosody: {
                speechDetected: true, // Assume speech if we have emotions
                valence,
                arousal,
                emotions,
                warnings: [],
              },
              debug: {
                rawPreview: preview,
                rawHash: this.sha256(text),
              },
            };
            this.logger.log(`[Hume][EMOTIONS] Emitting event without prosody object (emotions found elsewhere)`);
            this.emitter.emit('feedback.ingestion', evt);
          }
        }
        if (errorMsg) {
          this.logger.error(
            `[Hume][RECV][ERROR] type=${type ?? 'unknown'} status=${String(status ?? '')} msg="${errorMsg}" raw="${preview}"`,
          );
        } else {
          const keys = isObj ? Object.keys(obj as Record<string, unknown>) : [];
          this.logger.log(
            `[Hume][RECV][OK] type=${type ?? 'unknown'} status=${String(status ?? '')} keys=[${keys.slice(0, 10).join(', ')}] raw="${preview}"`,
          );
        }
      } catch {
        this.logger.log(`[Hume][RECV][TEXT] ${preview}`);
      }
    });
    ws.on('error', (err: Error) => {
      this.logger.error(`[Hume][WS][ERROR] for ${key}: ${err.name}: ${err.message}`);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      const reasonText = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason ?? '');
      this.logger.warn(`[Hume][WS][CLOSE] for ${key}: code=${code} reason="${reasonText}"`);
      this.keyToConn.delete(key);
    });
    return conn;
  }

  private buildDataPayload(wavChunk: Buffer): string {
    const b64 = Buffer.from(wavChunk).toString('base64');
    const payload: Record<string, unknown> = {
      data: b64,
      // Use 'prosody' model - it returns emotions array by default in recent API versions
      // The emotions array contains all 48 emotions + Valence/Arousal
      models: {
        prosody: {},
      },
    };
    return JSON.stringify(payload);
  }

  private describePayload(payload: string): string {
    try {
      const obj = JSON.parse(payload) as { data?: unknown; models?: unknown };
      const dataLen = typeof obj.data === 'string' ? (obj.data as string).length : 0;
      return `kind=data+models chars=${payload.length} dataLen=${dataLen}`;
    } catch {
      return `chars=${payload.length}`;
    }
  }

  private buildKey(meta: HumeMeta): string {
    return `${meta.meetingId}:${meta.participant}:${meta.track}`;
  }

  private parseKey(key: string): [string, string, string] {
    const parts = key.split(':');
    const meetingId = parts[0] ?? '';
    const participant = parts[1] ?? '';
    const track = parts[2] ?? '';
    return [meetingId, participant, track];
  }

  private sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  private computeRmsDbfsFromWav(wav: Buffer): number {
    if (wav.length < 44) return Number.NEGATIVE_INFINITY;
    const dataOffset = 44;
    const pcmLen = wav.length - dataOffset;
    if (pcmLen <= 0) return Number.NEGATIVE_INFINITY;
    const view = new DataView(wav.buffer, wav.byteOffset + dataOffset, pcmLen);
    let sumSquares = 0;
    const n = Math.floor(pcmLen / 2);
    if (n <= 0) return Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const s = view.getInt16(i * 2, true);
      const norm = s / 32768;
      sumSquares += norm * norm;
    }
    const rms = Math.sqrt(sumSquares / n);
    if (rms <= 0) return Number.NEGATIVE_INFINITY;
    const dbfs = 20 * Math.log10(rms);
    // Clamp to a floor to avoid -Infinity downstream
    return Math.max(-100, Math.min(0, dbfs));
  }

  /**
   * Recursively searches for 'emotions' array and V/A metrics.
   */
  private extractEmotionsAndMetrics(
    input: unknown,
  ): { valence?: number; arousal?: number; emotions?: Record<string, number> } {
    let foundValence: number | undefined;
    let foundArousal: number | undefined;
    let foundEmotions: Record<string, number> | undefined;

    const seen = new Set<unknown>();
    const visit = (node: unknown): void => {
      if (node === null || node === undefined) return;
      if (typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          if (
            foundValence !== undefined &&
            foundArousal !== undefined &&
            foundEmotions !== undefined
          )
            return;
          visit(item);
        }
        return;
      }

      const rec = node as Record<string, unknown>;
      
      // Look for emotions array: [{name: "Anger", score: 0.5}, ...]
      if (Array.isArray(rec['emotions'])) {
        const list = rec['emotions'] as Array<unknown>;
        const map: Record<string, number> = {};
        let hasValid = false;
        for (const item of list) {
          if (
            item &&
            typeof item === 'object' &&
            'name' in item &&
            'score' in item
          ) {
            const i = item as { name: unknown; score: unknown };
            if (typeof i.name === 'string' && typeof i.score === 'number') {
              map[i.name] = i.score;
              hasValid = true;
            }
          }
        }
        if (hasValid && !foundEmotions) {
          foundEmotions = map;
        }
      }

      for (const [k, v] of Object.entries(rec)) {
        const key = k.toLowerCase();
        if ((key === 'valence' || key.endsWith('_valence')) && typeof v === 'number') {
          foundValence = this.clampMinus1To1(v);
        } else if ((key === 'arousal' || key.endsWith('_arousal')) && typeof v === 'number') {
          foundArousal = this.clampMinus1To1(v);
        } else if (typeof v === 'object' && v !== null) {
          if (foundValence !== undefined && foundArousal !== undefined && foundEmotions !== undefined) break;
          visit(v);
        }
      }
    };

    visit(input);
    return { valence: foundValence, arousal: foundArousal, emotions: foundEmotions };
  }

  private clampMinus1To1(v: number): number {
    if (!Number.isFinite(v)) return v;
    if (v < -1) return -1;
    if (v > 1) return 1;
    return v;
  }

  onModuleDestroy(): void {
    // Gracefully close all open WS connections on shutdown
    for (const [key, conn] of this.keyToConn.entries()) {
      try {
        conn.ws.close();
      } catch {}
      this.keyToConn.delete(key);
      this.logger.log(`[Hume] closed WS for ${key}`);
    }
  }
}
