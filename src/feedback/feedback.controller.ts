import { Controller, Get, Param } from '@nestjs/common';
import { FeedbackAggregatorService } from './feedback.aggregator.service';
import { FeedbackDeliveryService } from './feedback.delivery.service';

@Controller('feedback')
export class FeedbackController {
  constructor(
    private readonly aggregator: FeedbackAggregatorService,
    private readonly delivery: FeedbackDeliveryService,
  ) {}

  @Get('debug/:meetingId')
  getDebug(@Param('meetingId') meetingId: string) {
    return this.aggregator.getMeetingDebug(meetingId);
  }

  @Get('metrics/:meetingId')
  getMetrics(@Param('meetingId') meetingId: string) {
    return this.delivery.getMetrics(meetingId);
  }
}


