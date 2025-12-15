import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { setupAudioEgressWsServer, setupVideoEgressWsServer } from './egress/media-egress.server';
import { setupTranscriptionEgressWsServer } from './egress/transcription-egress.server';
import { PrismaService } from './prisma/prisma.service';
import { AudioPipelineService } from './pipeline/audio-pipeline.service';
import { TextAnalysisService } from './pipeline/text-analysis.service';
import * as path from 'path';
import * as fs from 'fs';
import type { Request, Response, NextFunction } from 'express';

async function bootstrap() {
  // Load env from ./env if present (apps/backend/env)
  try {
    const envPath = path.resolve(process.cwd(), 'env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        const key = match[1];
        let value = match[2];
        // remove optional surrounding quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    }
  } catch {}

  const app = await NestFactory.create(AppModule);

  // Enable CORS
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Parse LiveKit webhooks (application/webhook+json) sem depender de express/body-parser
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const ct = (req.headers['content-type'] as string) || '';
    if (ct.includes('application/webhook+json')) {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (data += chunk));
      req.on('end', () => {
        try {
          req.body = data ? JSON.parse(data) : {};
        } catch {
          req.body = {};
        }
        next();
      });
      return;
    }
    next();
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Prepare WS receiver for LiveKit audio egress (PCM → WAV)
  const httpServer = app.getHttpServer();
  const prisma = app.get(PrismaService);
  const audioPipeline = app.get(AudioPipelineService);
  const textAnalysisService = app.get(TextAnalysisService);
  setupAudioEgressWsServer(
    httpServer,
    {
      path: '/egress-audio',
      outputDir: process.env.EGRESS_AUDIO_OUTPUT_DIR,
    },
    prisma,
    audioPipeline,
  );
  setupVideoEgressWsServer(
    httpServer,
    {
      path: '/egress-video',
      outputDir: process.env.EGRESS_VIDEO_OUTPUT_DIR,
    },
    prisma,
  );
  setupTranscriptionEgressWsServer(
    httpServer,
    {
      path: '/egress-transcription',
    },
    textAnalysisService,
  );

  const port = process.env.PORT || 3001;
  await app.listen(port, '0.0.0.0');

  console.log(`🚀 Application is running on: http://0.0.0.0:${port}`);
}

bootstrap();
