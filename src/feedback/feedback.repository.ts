import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeedbackEventPayload } from './feedback.types';

@Injectable()
export class FeedbackRepository {
  private readonly logger = new Logger(FeedbackRepository.name);
  private readonly ttlDays: number;

  constructor(private readonly prisma: PrismaService) {
    const n = Number(process.env.FEEDBACK_TTL_DAYS || '14');
    this.ttlDays = Number.isFinite(n) && n > 0 ? n : 14;
  }

  async saveEvent(evt: FeedbackEventPayload): Promise<void> {
    try {
      const expiresAt = new Date(evt.ts + this.ttlDays * 24 * 60 * 60 * 1000);
      await this.prisma.feedbackEvent.create({
        data: {
          id: evt.id,
          meetingId: evt.meetingId,
          participantId: evt.participantId,
          type: evt.type as unknown as any, // Prisma enum inferred; TS maps string union
          severity: evt.severity as unknown as any,
          ts: new Date(evt.ts),
          windowStart: new Date(evt.window.start),
          windowEnd: new Date(evt.window.end),
          message: evt.message,
          metadata: evt.metadata ?? {},
          expiresAt,
        },
      });
      // best-effort cleanup of expired rows
      await this.prisma.feedbackEvent.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
    } catch (e) {
      this.logger.warn(`Failed to save feedback event: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}


