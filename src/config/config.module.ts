import { Global, Module } from '@nestjs/common';

@Global()
@Module({
  providers: [
    // Hume
    {
      provide: 'HUME_WS_URL',
      useFactory: () => process.env.HUME_WS_URL || 'wss://api.hume.ai/v0/stream/models',
    },
    { provide: 'HUME_API_KEY', useFactory: () => process.env.HUME_API_KEY },
    {
      provide: 'HUME_WS_HEADERS',
      useFactory: (apiKey?: string): Record<string, string> => {
        const headers: Record<string, string> = {};
        if (apiKey) headers['X-Hume-Api-Key'] = apiKey;
        return headers;
      },
      inject: ['HUME_API_KEY'],
    },
    // LiveKit / Egress
    {
      provide: 'LIVEKIT_API_URL',
      useFactory: () =>
        process.env.LIVEKIT_API_URL || process.env.LIVEKIT_HOST || 'http://localhost:7880',
    },
    { provide: 'LIVEKIT_API_KEY', useFactory: () => process.env.LIVEKIT_API_KEY },
    { provide: 'LIVEKIT_API_SECRET', useFactory: () => process.env.LIVEKIT_API_SECRET },
    {
      provide: 'EGRESS_WS_BASE',
      useFactory: () => process.env.EGRESS_WS_BASE || 'ws://localhost:3001',
    },
    // Server
    { provide: 'PORT', useFactory: () => Number(process.env.PORT || 3001) },
  ],
  exports: [
    'HUME_WS_URL',
    'HUME_API_KEY',
    'HUME_WS_HEADERS',
    'LIVEKIT_API_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'EGRESS_WS_BASE',
    'PORT',
  ],
})
export class ConfigModule {}
