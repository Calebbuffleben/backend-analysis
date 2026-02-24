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
      this.logger.log('Deep results consumer disabled.', {
        DEEP_QUEUE_ENABLED: process.env.DEEP_QUEUE_ENABLED,
        DEEP_REDIS_URL_configured: !!(process.env.DEEP_REDIS_URL || process.env.REDIS_URL),
      });
      return;
    }

    const url = process.env.DEEP_REDIS_URL || process.env.REDIS_URL || '';
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: true });
    this.running = true;

    // Add error handler to prevent unhandled error events
    this.redis.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });

    try {
      // Create group best-effort
      await this.redis.xgroup('CREATE', this.streamKey, this.group, '0-0', 'MKSTREAM');
      this.logger.debug(`Created consumer group ${this.group} for stream ${this.streamKey}`);
    } catch {
      // group likely exists
      this.logger.debug(`Consumer group ${this.group} already exists for stream ${this.streamKey}`);
    }

    this.loop().catch((e) => {
      this.logger.error(`Deep results consumer loop crashed: ${e instanceof Error ? e.message : String(e)}`, {
        error: e instanceof Error ? e.stack : undefined,
      });
    });

    this.logger.log(`✅ [DEEP_QUEUE] Results consumer started and healthy`, {
      mode: 'DEEP_QUEUE',
      stream: this.streamKey,
      group: this.group,
      consumer: this.consumer,
      redis_connected: true,
      status: 'ACTIVE',
      note: 'Consuming text analysis results from Redis Stream',
    });
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
        const res = (await this.redis.xreadgroup(
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
        )) as unknown;

        if (!Array.isArray(res) || res.length === 0) continue;
        const firstStream = res[0];
        if (!Array.isArray(firstStream) || firstStream.length < 2) continue;
        const entries = firstStream[1] as Array<[string, Array<string>]>;
        if (!entries || entries.length === 0) continue;

        const [id, kv] = entries[0];
        const obj: Record<string, string> = {};
        for (let i = 0; i < kv.length; i += 2) {
          obj[kv[i]] = kv[i + 1];
        }

        const json = obj['json'];
        if (json) {
          const t7_received = Date.now();
          const parsed = JSON.parse(json) as TextAnalysisResult;
          
          // Extrair timing do Python (se disponível)
          const timing = (parsed as any).timing;
          const t0_capture = timing?.t0_capture || parsed.timestamp;
          const t5_complete = timing?.t5_processing_complete;
          
          this.logger.log(`[LATENCY] Result received from Redis`, {
            meetingId: parsed.meetingId,
            participantId: parsed.participantId,
            timestamps: {
              t0_capture,
              t5_complete,
              t7_received,
            },
            latencies_ms: {
              python_processing: t5_complete ? (t5_complete - t0_capture) : 'unknown',
              result_delivery: t5_complete ? (t7_received - t5_complete) : 'unknown',
              end_to_end: t7_received - t0_capture,
            },
            sales_category: parsed.analysis.sales_category,
          });
          
          this.emitter.emit('text.analysis', parsed);
          
          const t8_emitted = Date.now();
          this.logger.debug(`[LATENCY] Event emitted`, {
            meetingId: parsed.meetingId,
            emit_duration_ms: t8_emitted - t7_received,
          });
        }

        await this.redis.xack(this.streamKey, this.group, id);
      } catch (e) {
        this.logger.warn(`Deep results consumer error: ${e instanceof Error ? e.message : String(e)}`, {
          error: e instanceof Error ? e.stack : undefined,
        });
      }
    }
  }
}

