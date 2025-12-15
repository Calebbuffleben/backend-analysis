import { Logger } from '@nestjs/common';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import type { Socket } from 'net';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
type SessionStatusLiteral = 'ACTIVE' | 'ENDED';
interface SessionLookup {
  meetingId: string;
}
interface PrismaSessionDelegate {
  findFirst(params: {
    where: { roomName: string; status: SessionStatusLiteral };
    orderBy: { startedAt: 'desc' };
  }): Promise<SessionLookup | null>;
}

function extractSession(prisma: unknown): PrismaSessionDelegate | undefined {
  if (
    typeof prisma === 'object' &&
    prisma !== null &&
    'session' in (prisma as Record<string, unknown>)
  ) {
    const candidate = (prisma as { session?: unknown }).session;
    if (candidate && typeof (candidate as { findFirst?: unknown }).findFirst === 'function') {
      return candidate as PrismaSessionDelegate;
    }
  }
  return undefined;
}

type AudioPipelineLike = {
  enqueueChunk(
    args: {
      meetingId: string;
      participant: string;
      track: string;
      sampleRate: number;
      channels: number;
      groupSeconds?: number;
    },
    data: Buffer,
  ): void | Promise<void>;
  clear(args: {
    meetingId: string;
    participant: string;
    track: string;
    sampleRate: number;
    channels: number;
    groupSeconds?: number;
  }): void | Promise<void>;
};

type AudioEgressWsOptions = {
  path?: string; // HTTP upgrade path, e.g. /egress-audio
  outputDir?: string; // Directory to write WAV files
  defaultSampleRate?: number; // Hz
  defaultNumChannels?: number; // channels
};

type VideoEgressWsOptions = {
  path?: string; // HTTP upgrade path, e.g. /egress-video
  outputDir?: string; // Directory to write encoded video bytestream
};

const log = new Logger('MediaEgressWS');

class WavWriter {
  private filePath: string;
  private handle: fsp.FileHandle | null = null;
  private bytesWritten: number = 0; // only PCM data section bytes
  private readonly sampleRate: number;
  private readonly numChannels: number;
  private readonly bitsPerSample: number = 16; // pcm_s16le

  constructor(filePath: string, sampleRate: number, numChannels: number) {
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.numChannels = numChannels;
  }

  async open(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    this.handle = await fsp.open(this.filePath, 'w');
    const header = this.buildHeader(0);
    await this.handle.write(header, 0, header.length, 0);
  }

  async appendPcm(buffer: Buffer): Promise<void> {
    if (this.handle === null) throw new Error('WavWriter not opened');
    const offset = 44 + this.bytesWritten;
    await this.handle.write(buffer, 0, buffer.length, offset);
    this.bytesWritten += buffer.length;
  }

  async close(): Promise<void> {
    if (this.handle === null) return;
    const header = this.buildHeader(this.bytesWritten);
    await this.handle.write(header, 0, header.length, 0);
    await this.handle.close();
    this.handle = null;
  }

  private buildHeader(dataBytes: number): Buffer {
    const blockAlign = (this.numChannels * this.bitsPerSample) / 8;
    const byteRate = this.sampleRate * blockAlign;
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataBytes, 4); // chunk size
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // subchunk1 size (PCM)
    buffer.writeUInt16LE(1, 20); // audio format = 1 (PCM)
    buffer.writeUInt16LE(this.numChannels, 22);
    buffer.writeUInt32LE(this.sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(this.bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataBytes, 40);
    return buffer;
  }
}

function parseUrlParams(req: IncomingMessage): URLSearchParams {
  const requestUrl = req.url ?? '';
  const idx = requestUrl.indexOf('?');
  const qs = idx >= 0 ? requestUrl.substring(idx + 1) : '';
  return new URLSearchParams(qs);
}

function sanitize(input: string | undefined, fallback: string): string {
  const val = (input ?? fallback).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  return val.length > 0 ? val : fallback;
}

export function setupAudioEgressWsServer(
  httpServer: HttpServer,
  opts?: AudioEgressWsOptions,
  prisma?: unknown,
  pipeline?: AudioPipelineLike,
): void {
  const options: Required<AudioEgressWsOptions> = {
    path: opts?.path ?? '/egress-audio',
    // new default under storage/egress/audio
    outputDir: opts?.outputDir ?? path.resolve(process.cwd(), 'storage', 'egress', 'audio'),
    defaultSampleRate: opts?.defaultSampleRate ?? 48000,
    defaultNumChannels: opts?.defaultNumChannels ?? 1,
  } as const;

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    try {
      const url = request.url ?? '';
      if (!url.startsWith(options.path)) {
        return; // ignore other upgrade paths
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } catch (err) {
      log.error(`Upgrade error: ${(err as Error).message}`);
      socket.destroy();
    }
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const params = parseUrlParams(req);
    const room = sanitize(params.get('room') ?? params.get('roomName') ?? undefined, 'room');
    const participant = sanitize(params.get('participant') ?? undefined, 'participant');
    const track = sanitize(params.get('track') ?? params.get('trackId') ?? undefined, 'track');
    const qsMeetingId = params.get('meetingId') ?? undefined;
    const sampleRate = parseInt(params.get('sampleRate') || '', 10) || options.defaultSampleRate;
    const channels = parseInt(params.get('channels') || '', 10) || options.defaultNumChannels;
    const groupSeconds = parseFloat(params.get('groupSeconds') || '') || undefined;

    let meetingId = qsMeetingId ?? undefined;
    if (!meetingId) {
      try {
        const sessionDelegate = extractSession(prisma);
        if (sessionDelegate) {
          const session = await sessionDelegate.findFirst({
            where: { roomName: room, status: 'ACTIVE' },
            orderBy: { startedAt: 'desc' },
          });
          meetingId = session?.meetingId ?? undefined;
        }
      } catch {}
    }

    const groupDir = meetingId ? meetingId : room;
    const timestamp = new Date().toISOString().replace(/[:]/g, '-');
    const filename = `${timestamp}_${room}_${participant}_${track}.wav`;
    const filePath = path.join(options.outputDir, groupDir, filename);

    const wav = new WavWriter(filePath, sampleRate, channels);
    let muted = false;
    let totalBytes = 0;
    const id = `${room}/${participant}/${track}`;

    try {
      await wav.open();
      log.log(`Audio egress connected: ${id} → ${filePath}`);
    } catch (e) {
      log.error(`Failed to open WAV file for ${id}: ${(e as Error).message}`);
      ws.close();
      return;
    }

    ws.on('message', async (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      try {
        // Reduced logging to prevent spam - only log every 100 frames
        if (totalBytes % 64000 === 0) {
          log.log(`WS frame received (${id}) type=${typeof data} ctor=${(data as any)?.constructor?.name} isBinary=${isBinary}`);
        }
        let incoming = data;
        // Some environments deliver ArrayBuffer / TypedArray even when isBinary=false.
        if (!isBinary) {
          if (Array.isArray(data)) {
            isBinary = true;
          } else if (data instanceof ArrayBuffer) {
            incoming = Buffer.from(data);
            isBinary = true;
          } else if (ArrayBuffer.isView(data)) {
            const view = data as ArrayBufferView;
            incoming = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
            isBinary = true;
          }
        }
        if (isBinary) {
          if (!muted) {
            let buf: Buffer;
            if (Array.isArray(incoming)) {
              buf = Buffer.concat(incoming);
            } else if (Buffer.isBuffer(incoming)) {
              buf = incoming as Buffer;
            } else if (incoming instanceof ArrayBuffer) {
              buf = Buffer.from(incoming);
            } else if (ArrayBuffer.isView(incoming)) {
              const view = incoming as ArrayBufferView;
              buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
            } else {
              throw new Error(`Unsupported binary frame payload type: ${typeof incoming}`);
            }
            // Reduced logging - only log every ~64KB
            if (totalBytes % 64000 === 0) {
              log.log(`Binary frame ${buf.length} bytes (${id}) - Total: ${(totalBytes / 1024).toFixed(1)}KB`);
            }
            // DEBUG: Log first 20 samples to verify audio data is not all zeros (only once)
            if (buf.length >= 40 && totalBytes < 1000) {
              const samples: number[] = [];
              for (let i = 0; i < Math.min(20, buf.length / 2); i++) {
                samples.push(buf.readInt16LE(i * 2));
              }
              log.log(`[AUDIO DEBUG] First 20 samples: ${samples.join(',')}`);
            }
            totalBytes += buf.length;
            await wav.appendPcm(buf);
            if (meetingId && pipeline) {
              await pipeline.enqueueChunk(
                {
                  meetingId,
                  participant,
                  track,
                  sampleRate,
                  channels,
                  groupSeconds,
                },
                buf,
              );
            }
          }
          return;
        }
        // text frame: expected JSON with events like { muted: true }
        const text =
          Buffer.isBuffer(data) || data instanceof Uint8Array
            ? Buffer.from(data).toString('utf8')
            : String(data);
        try {
          const payload = JSON.parse(text) as { muted?: boolean };
          if (typeof payload.muted === 'boolean') {
            muted = payload.muted;
            log.log(`Muted state changed (${id}): ${muted}`);
          }
        } catch (err) {
          log.warn(`Non-JSON text frame received (${id}): ${text}`);
        }
      } catch (err) {
        log.error(`Error handling WS message (${id}): ${(err as Error).message}`);
      }
    });

    ws.on('close', async () => {
      try {
        await wav.close();
        log.log(
          `Audio egress disconnected: ${id}. Wrote ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
        );
      } catch (err) {
        log.error(`Error closing WAV for ${id}: ${(err as Error).message}`);
      }
      if (meetingId && pipeline) {
        try {
          await pipeline.clear({ meetingId, participant, track, sampleRate, channels });
        } catch {}
      }
    });

    ws.on('error', async (err: Error) => {
      log.error(`WS error (${id}): ${err.message}`);
      try {
        await wav.close();
      } catch (_) {}
    });
  });

  log.log(
    `Audio Egress WS ready on path ${options.path}, writing to ${path.resolve(options.outputDir)} (sr=${options.defaultSampleRate}, ch=${options.defaultNumChannels})`,
  );
}

class RawFileWriter {
  private filePath: string;
  private handle: fsp.FileHandle | null = null;
  private bytesWritten = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async open(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    this.handle = await fsp.open(this.filePath, 'w');
  }

  async append(data: Buffer): Promise<void> {
    if (!this.handle) throw new Error('RawFileWriter not opened');
    await this.handle.write(data);
    this.bytesWritten += data.length;
  }

  async close(): Promise<void> {
    if (!this.handle) return;
    await this.handle.close();
    this.handle = null;
  }
}

function pickVideoFilename(
  baseDir: string,
  room: string,
  participant: string,
  track: string,
  codec?: string | null,
): string {
  const timestamp = new Date().toISOString().replace(/[:]/g, '-');
  const safeCodec = codec ? codec.toLowerCase() : 'bin';
  let ext = 'bin';
  if (safeCodec === 'h264' || safeCodec === 'avc') ext = 'h264';
  if (safeCodec === 'vp8' || safeCodec === 'vp9') ext = 'ivf'; // raw IVF bytestream (no header)
  return path.join(baseDir, `${timestamp}_${room}_${participant}_${track}.${ext}`);
}

export function setupVideoEgressWsServer(
  httpServer: HttpServer,
  opts?: VideoEgressWsOptions,
  prisma?: unknown,
): void {
  const options: Required<VideoEgressWsOptions> = {
    path: opts?.path ?? '/egress-video',
    // new default under storage/egress/video
    outputDir: opts?.outputDir ?? path.resolve(process.cwd(), 'storage', 'egress', 'video'),
  } as const;

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
      log.error(`Upgrade error (video): ${(err as Error).message}`);
      socket.destroy();
    }
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const params = parseUrlParams(req);
    const room = sanitize(params.get('room') ?? params.get('roomName') ?? undefined, 'room');
    const participant = sanitize(params.get('participant') ?? undefined, 'participant');
    const track = sanitize(params.get('track') ?? params.get('trackId') ?? undefined, 'track');
    const codec = params.get('codec'); // e.g. h264|vp8|vp9
    const qsMeetingId = params.get('meetingId') ?? undefined;
    let meetingId = qsMeetingId ?? undefined;
    if (!meetingId) {
      try {
        const sessionDelegate = extractSession(prisma);
        if (sessionDelegate) {
          const session = await sessionDelegate.findFirst({
            where: { roomName: room, status: 'ACTIVE' },
            orderBy: { startedAt: 'desc' },
          });
          meetingId = session?.meetingId ?? undefined;
        }
      } catch {}
    }

    const groupDir = meetingId ? meetingId : room;
    const baseDir = path.join(options.outputDir, groupDir);
    const filePath = pickVideoFilename(baseDir, room, participant, track, codec);
    const writer = new RawFileWriter(filePath);
    let totalBytes = 0;
    const id = `${room}/${participant}/${track}`;

    try {
      await writer.open();
      log.log(`Video egress connected: ${id} → ${filePath}`);
    } catch (e) {
      log.error(`Failed to open output for ${id}: ${(e as Error).message}`);
      ws.close();
      return;
    }

    ws.on('message', async (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      try {
        if (isBinary) {
          let buf: Buffer;
          if (Array.isArray(data)) buf = Buffer.concat(data);
          else if (Buffer.isBuffer(data)) buf = data as Buffer;
          else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
          else if (ArrayBuffer.isView(data)) buf = Buffer.from(data);
          else throw new Error(`Unsupported video binary payload type: ${typeof data}`);
          totalBytes += buf.length;
          await writer.append(buf);
          return;
        }
        // ignore text frames for now (could carry pause/resume events)
      } catch (err) {
        log.error(`Error handling WS video message (${id}): ${(err as Error).message}`);
      }
    });

    ws.on('close', async () => {
      try {
        await writer.close();
        log.log(
          `Video egress disconnected: ${id}. Wrote ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
        );
      } catch (err) {
        log.error(`Error closing video file for ${id}: ${(err as Error).message}`);
      }
    });

    ws.on('error', async (err: Error) => {
      log.error(`WS error (video) (${id}): ${err.message}`);
      try {
        await writer.close();
      } catch (_) {}
    });
  });

  log.log(
    `Video Egress WS ready on path ${options.path}, writing to ${path.resolve(options.outputDir)}`,
  );
}
