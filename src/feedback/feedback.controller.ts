import { Controller, Get, Param } from '@nestjs/common';
import { FeedbackDeliveryService } from './feedback.delivery.service';

@Controller('feedback')
export class FeedbackController {
  constructor(private readonly delivery: FeedbackDeliveryService) {}

  @Get('metrics/:meetingId')
  getMetrics(@Param('meetingId') meetingId: string) {
    return this.delivery.getMetrics(meetingId);
  }
}


