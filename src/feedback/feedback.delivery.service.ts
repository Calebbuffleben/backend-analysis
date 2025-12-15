import { Injectable } from '@nestjs/common';
import { AppWebSocketGateway } from '../websocket/websocket.gateway';
import { FeedbackEventPayload } from './feedback.types';
import { FeedbackRepository } from './feedback.repository';

@Injectable()
export class FeedbackDeliveryService {
  private readonly metricsByMeeting = new Map<
    string,
    {
      counts: Map<string, number>;
      latencies: number[]; // last N latencies ms
      maxSamples: number;
    }
  >();

  constructor(
    private readonly wsGateway: AppWebSocketGateway,
    private readonly repo: FeedbackRepository,
  ) {}

  publishToHosts(meetingId: string, payload: FeedbackEventPayload): void {
    const room = `feedback:${meetingId}`;
    // Emit to room; frontend hosts should subscribe to this room
    try {
      // Simple debug log for observability
      // eslint-disable-next-line no-console
      console.log(
        `[FeedbackDelivery] emit type=${payload.type} sev=${payload.severity} meetingId=${meetingId}`,
      );
    } catch {}
    this.wsGateway.server.to(room).emit('feedback', payload);
    void this.repo.saveEvent(payload);
    this.recordMetrics(meetingId, payload);
  }

  getMetrics(meetingId: string): {
    meetingId: string;
    counts: Record<string, number>;
    latencyAvgMs?: number;
    samples: number;
  } {
    const m = this.metricsByMeeting.get(meetingId);
    if (!m) return { meetingId, counts: {}, samples: 0 };
    const countsObj: Record<string, number> = {};
    for (const [k, v] of m.counts.entries()) countsObj[k] = v;
    const samples = m.latencies.length;
    const latencyAvgMs = samples > 0 ? Math.round(m.latencies.reduce((a, b) => a + b, 0) / samples) : undefined;
    return { meetingId, counts: countsObj, latencyAvgMs, samples };
  }

  private recordMetrics(meetingId: string, payload: FeedbackEventPayload): void {
    let m = this.metricsByMeeting.get(meetingId);
    if (!m) {
      m = { counts: new Map<string, number>(), latencies: [], maxSamples: 100 };
      this.metricsByMeeting.set(meetingId, m);
    }
    m.counts.set(payload.type, (m.counts.get(payload.type) ?? 0) + 1);
    const latency = Date.now() - payload.ts;
    m.latencies.push(latency);
    if (m.latencies.length > m.maxSamples) {
      m.latencies.splice(0, m.latencies.length - m.maxSamples);
    }
  }
}
