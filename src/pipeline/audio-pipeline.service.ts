import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { HumeStreamService } from './hume-stream.service';
import { TextAnalysisService } from './text-analysis.service';
import { DeepQueueService } from './deep-queue.service';

export type AudioChunkMeta = {
  meetingId: string;
  participant: string;
  track: string;
  sampleRate: number; // Hz
  channels: number; // 1 or 2
  groupSeconds?: number; // optional per-call override
};

type BufferState = {
  buffers: Buffer[];
  bytesAccumulated: number;
  thresholdBytes: number;
  lastFlushAt: number;
  firstChunkAt: number;
  seq: number;
};

@Injectable()
export class AudioPipelineService {
  private readonly logger = new Logger(AudioPipelineService.name);
  private keyToState = new Map<string, BufferState>();
  private readonly defaultGroupSeconds: number;
  private readonly humeTargetSampleRate: number;
  private readonly humeTargetChannels: number = 1;

  constructor(
    private readonly hume: HumeStreamService,
    private readonly textAnalysis: TextAnalysisService,
    private readonly deepQueue: DeepQueueService,
  ) {
    const seconds = Number(process.env.AUDIO_PIPELINE_GROUP_SECONDS || '2');
    this.defaultGroupSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 2;
    const targetSr = Number(process.env.HUME_TARGET_SAMPLE_RATE || '16000');
    this.humeTargetSampleRate = Number.isFinite(targetSr) && targetSr > 0 ? targetSr : 16000;
    
    // Verificar se transcrição de áudio está habilitada
    const transcriptionEnabled = (process.env.AUDIO_TRANSCRIPTION_ENABLED || 'true') === 'true';
    if (transcriptionEnabled) {
      this.logger.log('Audio transcription enabled - audio will be sent for transcription');
    }
  }

  enqueueChunk(meta: AudioChunkMeta, data: Buffer): void {
    const key = this.buildKey(meta);
    const groupSeconds =
      meta.groupSeconds && meta.groupSeconds > 0 ? meta.groupSeconds : this.defaultGroupSeconds;
    const thresholdBytes = this.computeThresholdBytes(meta, groupSeconds);
    let state = this.keyToState.get(key);
    if (!state) {
      state = {
        buffers: [],
        bytesAccumulated: 0,
        thresholdBytes,
        lastFlushAt: Date.now(),
        firstChunkAt: Date.now(),
        seq: 0,
      };
      this.keyToState.set(key, state);
    }

    state.buffers.push(data);
    state.bytesAccumulated += data.length;
    if (state.buffers.length === 1) {
      state.firstChunkAt = Date.now();
    }

    const timeSinceLastFlush = Date.now() - state.lastFlushAt;
    const timeTriggerMs = Math.max(
      500,
      (meta.groupSeconds && meta.groupSeconds > 0 ? meta.groupSeconds : this.defaultGroupSeconds) *
        1000,
    );

    if (state.bytesAccumulated >= state.thresholdBytes || timeSinceLastFlush >= timeTriggerMs) {
      this.flush(meta, key, state);
    }
  }

  clear(meta: AudioChunkMeta): void {
    const key = this.buildKey(meta);
    const state = this.keyToState.get(key);
    if (state) {
      this.keyToState.delete(key);
    }
  }

  private flush(meta: AudioChunkMeta, key: string, state: BufferState): void {
    if (state.bytesAccumulated === 0) {
      return;
    }
    const payload = Buffer.concat(state.buffers, state.bytesAccumulated);
    state.buffers = [];
    state.bytesAccumulated = 0;
    state.lastFlushAt = Date.now();
    state.seq += 1;

    const captureTs = state.lastFlushAt; // coarse; will be refined to end-of-window timestamp
    const seq = state.seq;

    this.dispatchToHume(meta, payload, captureTs, seq).catch((err) => {
      this.logger.error(
        `Dispatch error for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private computeThresholdBytes(meta: AudioChunkMeta, seconds: number): number {
    const bytesPerSamplePerChannel = 2; // s16le
    return Math.floor(meta.sampleRate * bytesPerSamplePerChannel * meta.channels * seconds);
  }

  private buildKey(meta: AudioChunkMeta): string {
    return `${meta.meetingId}:${meta.participant}:${meta.track}`;
  }

  private async dispatchToHume(meta: AudioChunkMeta, pcm: Buffer, captureTs: number, seq: number): Promise<void> {
    const t1_received = Date.now();
    
    // P1.1: Normalização RMS habilitada por padrão para melhorar qualidade de transcrição
    // Reduz alucinações em áudio com baixo volume
    const normalize = (process.env.AUDIO_PIPELINE_NORMALIZE || 'true') === 'true';
    const payloadFormat = (process.env.AUDIO_PIPELINE_PAYLOAD || 'wav').toLowerCase(); // prefer wav for WS
    // 1) optional normalization
    let processedPcm = normalize ? this.normalizeVolume(pcm) : pcm;

    // Fast audio signal (local, lightweight): compute coarse RMS dBFS for stateful, windowed decisions.
    // This must never block on Whisper/SBERT.
    const rmsDbfs = this.computeRmsDbfs(processedPcm);
    const isSpeechLikely = rmsDbfs > -45; // coarse threshold; tuned via logs/metrics later
    this.logger.debug(`[FAST_AUDIO] ${meta.meetingId}/${meta.participant}/${meta.track}`, {
      rmsDbfs: Number.isFinite(rmsDbfs) ? Math.round(rmsDbfs * 10) / 10 : null,
      isSpeechLikely,
      tsCaptureMs: captureTs,
      seq,
    });

    // 2) convert to mono if needed
    if (meta.channels !== this.humeTargetChannels) {
      processedPcm = this.toMono(processedPcm, meta.channels);
    }
    // 3) resample if needed
    if (meta.sampleRate !== this.humeTargetSampleRate) {
      processedPcm = this.resampleLinear(processedPcm, meta.sampleRate, this.humeTargetSampleRate);
    }
    // 4) wrap to WAV at target rate/channels for WS
    const wavBody =
      payloadFormat === 'wav'
        ? this.buildWav(processedPcm, this.humeTargetSampleRate, this.humeTargetChannels)
        : this.buildWav(processedPcm, this.humeTargetSampleRate, this.humeTargetChannels);
    await this.appendLocalLog(meta, wavBody.length);
    await this.hume.sendChunk(
      {
        meetingId: meta.meetingId,
        participant: meta.participant,
        track: meta.track,
        sampleRate: this.humeTargetSampleRate,
        channels: this.humeTargetChannels,
      },
      wavBody,
    );
    
    // Deep path: enqueue to Redis stream (preferred), or fallback to Socket.IO → Python.
    const deepQueueEnabled = this.deepQueue.isEnabled();
    const transcriptionEnabled = (process.env.AUDIO_TRANSCRIPTION_ENABLED || 'true') === 'true';
    const t2_ready_to_enqueue = Date.now();
    
    if (deepQueueEnabled) {
      await this.deepQueue.enqueueAudio({
        meetingId: meta.meetingId,
        participantId: meta.participant,
        track: meta.track,
        wavBase64: wavBody.toString('base64'),
        sampleRate: this.humeTargetSampleRate,
        channels: this.humeTargetChannels,
        tsCaptureMs: captureTs,
        tsEnqueueMs: Date.now(),
        seq,
      });
      
      const t3_enqueued = Date.now();
      
      // Log de latência
      this.logger.debug(`[LATENCY] Audio pipeline timing`, {
        meetingId: meta.meetingId,
        participantId: meta.participant,
        seq,
        timestamps: {
          t0_capture: captureTs,
          t1_received: t1_received,
          t2_ready: t2_ready_to_enqueue,
          t3_enqueued: t3_enqueued,
        },
        latencies_ms: {
          capture_to_received: t1_received - captureTs,
          received_to_ready: t2_ready_to_enqueue - t1_received,
          ready_to_enqueued: t3_enqueued - t2_ready_to_enqueue,
          total_backend: t3_enqueued - t1_received,
        },
      });
      
      return;
    }

    // Socket.IO path
    const isTextAnalysisAvailable = true; // Sempre disponível agora (não é mais @Optional)
    const isTextAnalysisConnected = this.textAnalysis.isConnected();
    const isTextAnalysisHealthy = this.textAnalysis.isHealthy();
    
    this.logger.debug(
      `[AUDIO_ROUTING] Using Socket.IO for transcription`,
      {
        enabled: transcriptionEnabled,
        connected: isTextAnalysisConnected,
        healthy: isTextAnalysisHealthy,
        mode: 'SOCKET_IO',
        note: isTextAnalysisConnected 
          ? 'Direct connection to Python service' 
          : 'Python service not connected - audio will be dropped',
      }
    );

    if (transcriptionEnabled && isTextAnalysisAvailable && isTextAnalysisConnected && isTextAnalysisHealthy) {
      // Enviar de forma assíncrona para não bloquear o fluxo principal
      this.logger.debug(
        `Sending audio chunk for transcription: ${meta.meetingId}/${meta.participant}/${meta.track} (${wavBody.length} bytes)`,
      );
      this.textAnalysis
        .sendAudioChunk(
          meta.meetingId,
          meta.participant,
          meta.track,
          wavBody,
          this.humeTargetSampleRate,
          this.humeTargetChannels,
          captureTs,
          'pt', // Português por padrão
          seq,
        )
        .catch((err) => {
          this.logger.warn(
            `Failed to send audio for transcription: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } else {
      if (!transcriptionEnabled) {
        this.logger.debug('Audio transcription is disabled');
      } else if (!isTextAnalysisAvailable) {
        this.logger.debug('TextAnalysisService is not available');
      } else if (!isTextAnalysisConnected) {
        this.logger.debug('TextAnalysisService is not connected to Python service');
      } else if (!isTextAnalysisHealthy) {
        this.logger.warn(
          'TextAnalysisService connected, but did not receive pong from Python (likely wrong TEXT_ANALYSIS_SERVICE_URL or WS blocked)',
        );
      }
    }
  }

  // Imentiv HTTP removed. WS-based real-time streaming via Hume.

  private async appendLocalLog(meta: AudioChunkMeta, size: number): Promise<void> {
    try {
      const baseDir = path.resolve(process.cwd(), 'storage', 'pipeline-logs');
      await fsp.mkdir(baseDir, { recursive: true });
      const filePath = path.join(baseDir, `${meta.meetingId}.log`);
      const line = `${new Date().toISOString()} meetingId=${meta.meetingId} participant=${meta.participant} track=${meta.track} size=${size}\n`;
      await fsp.appendFile(filePath, line);
    } catch {}
  }

  private buildWav(pcmS16le: Buffer, sampleRate: number, channels: number): Buffer {
    const bitsPerSample = 16;
    const blockAlign = (channels * bitsPerSample) / 8;
    const byteRate = sampleRate * blockAlign;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmS16le.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmS16le.length, 40);
    return Buffer.concat([header, pcmS16le], 44 + pcmS16le.length);
  }

  private computeRmsDbfs(pcmS16leMonoOrMulti: Buffer): number {
    if (pcmS16leMonoOrMulti.length < 2) return Number.NEGATIVE_INFINITY;
    const view = new DataView(
      pcmS16leMonoOrMulti.buffer,
      pcmS16leMonoOrMulti.byteOffset,
      pcmS16leMonoOrMulti.byteLength,
    );
    const samples = Math.floor(pcmS16leMonoOrMulti.byteLength / 2);
    let sumSq = 0;
    for (let i = 0; i < samples; i++) {
      const s = view.getInt16(i * 2, true) / 32768;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, samples));
    if (rms <= 0) return Number.NEGATIVE_INFINITY;
    return 20 * Math.log10(rms);
  }

  private toMono(pcmS16le: Buffer, channels: number): Buffer {
    if (channels <= 1) return pcmS16le;
    const totalSamples = pcmS16le.length / 2; // 2 bytes per sample
    const samplesPerChannel = Math.floor(totalSamples / channels);
    const out = Buffer.allocUnsafe(samplesPerChannel * 2);
    const inView = new DataView(pcmS16le.buffer, pcmS16le.byteOffset, pcmS16le.byteLength);
    const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i < samplesPerChannel; i++) {
      let acc = 0;
      for (let ch = 0; ch < channels; ch++) {
        acc += inView.getInt16((i * channels + ch) * 2, true);
      }
      const avg = Math.max(-32768, Math.min(32767, Math.round(acc / channels)));
      outView.setInt16(i * 2, avg, true);
    }
    return out;
  }

  private resampleLinear(pcmMonoS16le: Buffer, srcRate: number, dstRate: number): Buffer {
    if (srcRate === dstRate) return pcmMonoS16le;
    const inSamples = pcmMonoS16le.length / 2;
    const outSamples = Math.round(inSamples * (dstRate / srcRate));
    const out = Buffer.allocUnsafe(outSamples * 2);
    const inView = new DataView(
      pcmMonoS16le.buffer,
      pcmMonoS16le.byteOffset,
      pcmMonoS16le.byteLength,
    );
    const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i < outSamples; i++) {
      const t = i * (srcRate / dstRate);
      const i0 = Math.floor(t);
      const i1 = Math.min(i0 + 1, inSamples - 1);
      const frac = t - i0;
      const s0 = inView.getInt16(i0 * 2, true);
      const s1 = inView.getInt16(i1 * 2, true);
      const interp = s0 + (s1 - s0) * frac;
      const clamped = Math.max(-32768, Math.min(32767, Math.round(interp)));
      outView.setInt16(i * 2, clamped, true);
    }
    return out;
  }

  private normalizeVolume(pcmS16le: Buffer): Buffer {
    // Simple peak normalization to ~0.9 of full scale
    const view = new DataView(pcmS16le.buffer, pcmS16le.byteOffset, pcmS16le.byteLength);
    let peak = 0;
    for (let i = 0; i < pcmS16le.length; i += 2) {
      const sample = view.getInt16(i, true);
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }
    if (peak === 0) return pcmS16le;
    const target = Math.floor(0.9 * 32767);
    const gain = target / peak;
    if (gain >= 1) return pcmS16le;
    const out = Buffer.allocUnsafe(pcmS16le.length);
    const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i < pcmS16le.length; i += 2) {
      const sample = view.getInt16(i, true);
      const scaled = Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
      outView.setInt16(i, scaled, true);
    }
    return out;
  }
}
