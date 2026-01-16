import { Controller, Get, Param } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FeedbackAggregatorService } from './feedback.aggregator.service';
import { FeedbackDeliveryService } from './feedback.delivery.service';
import { TextAnalysisResult } from '../pipeline/text-analysis.service';

@Controller('feedback')
export class FeedbackController {
  constructor(
    private readonly aggregator: FeedbackAggregatorService,
    private readonly delivery: FeedbackDeliveryService,
    private readonly emitter: EventEmitter2,
  ) {}

  @Get('debug/:meetingId')
  getDebug(@Param('meetingId') meetingId: string) {
    return this.aggregator.getMeetingDebug(meetingId);
  }

  @Get('metrics/:meetingId')
  getMetrics(@Param('meetingId') meetingId: string) {
    return this.delivery.getMetrics(meetingId);
  }

  // FASE 3: Endpoint de teste para validar que handler está registrado
  @Get('test/event-emitter')
  testEventEmitter() {
    const listenersCount = this.emitter.listenerCount('text.analysis');
    const testEvent: TextAnalysisResult = {
      meetingId: 'test-meeting',
      participantId: 'test-participant',
      text: 'Test event for sanity check',
      timestamp: Date.now(),
      confidence: 0.95,
      analysis: {
        intent: 'statement',
        intent_confidence: 0.5,
        topic: 'general',
        topic_confidence: 0.5,
        speech_act: 'statement',
        speech_act_confidence: 0.7,
        keywords: ['test'],
        entities: [],
        sentiment: 'neutral',
        sentiment_score: 0.5,
        urgency: 0.5,
        embedding: [],
        sales_category: 'stalling',
        sales_category_confidence: 0.17,
        sales_category_intensity: 0.34,
        sales_category_ambiguity: 0.98,
        sales_category_flags: {
          price_window_open: false,
          decision_signal_strong: false,
          ready_to_close: false,
          indecision_detected: false,
          decision_postponement_signal: false,
        },
      },
    };

    this.emitter.emit('text.analysis', testEvent);

    return {
      message: 'Event emitted, check logs for handleTextAnalysis()',
      listenersCount,
      testEvent: {
        meetingId: testEvent.meetingId,
        participantId: testEvent.participantId,
        text: testEvent.text,
        sales_category: testEvent.analysis.sales_category,
      },
    };
  }
}


