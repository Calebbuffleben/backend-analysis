import { Module } from '@nestjs/common';
import { AudioPipelineService } from './audio-pipeline.service';
import { HumeStreamService } from './hume-stream.service';
import { LiveKitWebhookModule } from '../livekit/livekit-webhook.module';
import { TextAnalysisModule } from './text-analysis.module';

@Module({
  imports: [LiveKitWebhookModule, TextAnalysisModule],
  providers: [AudioPipelineService, HumeStreamService],
  exports: [AudioPipelineService],
})
export class AudioPipelineModule {}
