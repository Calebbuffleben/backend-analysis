import { Module } from '@nestjs/common';
import { FeedbackAggregatorService } from './feedback.aggregator.service';
import { FeedbackDeliveryService } from './feedback.delivery.service';
import { FeedbackMeetingStateService } from './feedback-meeting-state.service';
import { FeedbackParticipantStateService } from './feedback-participant-state.service';
import { WebSocketModule } from '../websocket/websocket.module';
import { LiveKitWebhookModule } from '../livekit/livekit-webhook.module';
import { FeedbackController } from './feedback.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { FeedbackRepository } from './feedback.repository';

@Module({
  imports: [WebSocketModule, LiveKitWebhookModule, PrismaModule],
  controllers: [FeedbackController],
  providers: [FeedbackMeetingStateService, FeedbackParticipantStateService, FeedbackAggregatorService, FeedbackDeliveryService, FeedbackRepository],
  exports: [FeedbackAggregatorService, FeedbackDeliveryService],
})
export class FeedbackModule {}
