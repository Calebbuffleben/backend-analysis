import { Module } from '@nestjs/common';
import { TextAnalysisService } from './text-analysis.service';
import { DeepResultsConsumerService } from './deep-results-consumer.service';

@Module({
  providers: [TextAnalysisService, DeepResultsConsumerService],
  exports: [TextAnalysisService],
})
export class TextAnalysisModule {}

