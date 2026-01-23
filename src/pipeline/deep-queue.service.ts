import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

export type DeepAudioJob = {
  meetingId: string;
  participantId: string;
  track: string;
  wavBase64: string;
  sampleRate: number;
  channels: number;
  tsCaptureMs: number;
  tsEnqueueMs: number;
  seq?: number;
};

@Injectable()
export class DeepQueueService {
  private readonly logger = new Logger(DeepQueueService.name);
  private readonly redis: Redis | null;
  private readonly streamKey: string;

  constructor() {
    const url = process.env.DEEP_REDIS_URL || process.env.REDIS_URL || '';
    this.streamKey = process.env.DEEP_AUDIO_STREAM_KEY || 'deep:audio_jobs';

    if (!url) {
      this.redis = null;
      this.logger.warn('Redis not configured (DEEP_REDIS_URL/REDIS_URL missing). Deep queue disabled.');
      return;
    }

    this.redis = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }

  isEnabled(): boolean {
    const enabled = (process.env.DEEP_QUEUE_ENABLED || 'false') === 'true';
    return enabled && this.redis !== null;
  }

  async enqueueAudio(job: DeepAudioJob): Promise<void> {
    if (!this.isEnabled() || !this.redis) return;

    try {
      await this.redis.xadd(
        this.streamKey,
        '*',
        'meetingId',
        job.meetingId,
        'participantId',
        job.participantId,
        'track',
        job.track,
        'sampleRate',
        String(job.sampleRate),
        'channels',
        String(job.channels),
        'tsCaptureMs',
        String(job.tsCaptureMs),
        'tsEnqueueMs',
        String(job.tsEnqueueMs),
        'seq',
        String(job.seq ?? 0),
        'wavBase64',
        job.wavBase64,
      );
    } catch (e) {
      this.logger.warn(`Failed to enqueue deep audio job: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

