import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { WebSocketModule } from './websocket/websocket.module';
import { AppController } from './app.controller';
import { SessionsModule } from './sessions/sessions.module';
import { LiveKitWebhookModule } from './livekit/livekit-webhook.module';
import { AudioPipelineModule } from './pipeline/audio-pipeline.module';
import { TextAnalysisModule } from './pipeline/text-analysis.module';
import { FeedbackModule } from './feedback/feedback.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ConfigModule,
    PrismaModule,
    SessionsModule,
    LiveKitWebhookModule,
    AudioPipelineModule, // Já importa TextAnalysisModule internamente
    WebSocketModule,
    FeedbackModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
