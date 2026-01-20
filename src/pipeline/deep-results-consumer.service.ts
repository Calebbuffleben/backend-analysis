import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import type { TextAnalysisResult } from './text-analysis.service';

@Injectable()
export class DeepResultsConsumerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DeepResultsConsumerService.name);
  private readonly streamKey: string;
  private readonly group: string;
  private readonly consumer: string;
  private redis: Redis | null = null;
  private running = false;

  constructor(private readonly emitter: EventEmitter2) {
    this.streamKey = process.env.DEEP_RESULTS_STREAM_KEY || 'deep:text_results';
    this.group = process.env.DEEP_RESULTS_CONSUMER_GROUP || 'deep_results_backend';
    this.consumer = process.env.DEEP_RESULTS_CONSUMER_NAME || `backend-${process.pid}`;
  }

  private isEnabled(): boolean {
    const enabled = (process.env.DEEP_QUEUE_ENABLED || 'false') === 'true';
    const url = process.env.DEEP_REDIS_URL || process.env.REDIS_URL || '';
    return enabled && url.length > 0;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log('Deep results consumer disabled.');
      return;
    }

    const url = process.env.DEEP_REDIS_URL || process.env.REDIS_URL || '';
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: true });
    this.running = true;

    try {
      // Create group best-effort
      await this.redis.xgroup('CREATE', this.streamKey, this.group, '0-0', 'MKSTREAM');
    } catch {
      // group likely exists
    }

    this.loop().catch((e) => {
      this.logger.error(`Deep results consumer loop crashed: ${e instanceof Error ? e.message : String(e)}`);
    });

    this.logger.log(`Deep results consumer started (stream=${this.streamKey} group=${this.group} consumer=${this.consumer})`);
  }

  onApplicationShutdown(): void {
    this.running = false;
    try {
      this.redis?.disconnect();
    } catch {}
    this.redis = null;
  }

  private async loop(): Promise<void> {
    if (!this.redis) return;

    while (this.running) {
      try {
        const res = await this.redis.xreadgroup(
          'GROUP',
          this.group,
          this.consumer,
          'COUNT',
          1,
          'BLOCK',
          2000,
          'STREAMS',
          this.streamKey,
          '>',
        );

        if (!res || res.length === 0) continue;
        const [, entries] = res[0] as [string, Array<[string, Array<string>]>];
        if (!entries || entries.length === 0) continue;

        const [id, kv] = entries[0];
        const obj: Record<string, string> = {};
        for (let i = 0; i < kv.length; i += 2) {
          obj[kv[i]] = kv[i + 1];
        }

        const json = obj['json'];
        if (json) {
          const parsed = JSON.parse(json) as TextAnalysisResult;
          this.emitter.emit('text.analysis', parsed);
        }

        await this.redis.xack(this.streamKey, this.group, id);
      } catch (e) {
        this.logger.warn(`Deep results consumer error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

