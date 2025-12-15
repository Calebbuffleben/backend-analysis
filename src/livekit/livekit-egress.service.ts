import { Inject, Injectable, Logger } from '@nestjs/common';

type StartAudioEgressInput = {
  roomName: string;
  participant?: string;
  trackId: string;
  meetingId: string;
  sampleRate: number;
  channels: number;
  groupSeconds?: number;
};

@Injectable()
export class LiveKitEgressService {
  private readonly logger = new Logger(LiveKitEgressService.name);
  private readonly apiUrl: string;
  private readonly apiKey: string | undefined;
  private readonly apiSecret: string | undefined;
  private readonly egressWsBase: string;

  constructor(
    @Inject('LIVEKIT_API_URL') apiUrl: string,
    @Inject('LIVEKIT_API_KEY') apiKey: string | undefined,
    @Inject('LIVEKIT_API_SECRET') apiSecret: string | undefined,
    @Inject('EGRESS_WS_BASE') egressWsBase: string,
  ) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.egressWsBase = egressWsBase;
  }

  async startAudioTrackEgress(input: StartAudioEgressInput): Promise<void> {
    const { roomName, participant, trackId, meetingId, sampleRate, channels, groupSeconds } = input;
    const wsUrl = this.buildEgressWsUrl({
      roomName,
      participant: participant ?? '',
      trackId,
      meetingId,
      sampleRate,
      channels,
      groupSeconds,
    });
    const { EgressClient } = await import('livekit-server-sdk');
    if (!this.apiKey || !this.apiSecret) {
      this.logger.warn('LIVEKIT_API_KEY/SECRET not set; skipping startTrackEgress');
      return;
    }
    const client = new EgressClient(this.apiUrl, this.apiKey, this.apiSecret);
    this.logger.log(`Starting audio track egress: room=${roomName} trackId=${trackId} → ${wsUrl}`);
    const maxAttempts = 5;
    let lastError: unknown = undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // SDK expects (roomName, wsUrl, trackId). Passing wsUrl second avoids treating trackId as URL.
        await client.startTrackEgress(roomName, wsUrl, trackId);
        this.logger.log(`Audio egress started: room=${roomName} track=${trackId}`);
        return;
      } catch (e) {
        lastError = e;
        const msg = String(e);
        this.logger.error(`startTrackEgress attempt ${attempt}/${maxAttempts} failed: ${msg}`);
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private buildEgressWsUrl(args: {
    roomName: string;
    participant: string;
    trackId: string;
    meetingId: string;
    sampleRate: number;
    channels: number;
    groupSeconds?: number;
  }): string {
    const base = new URL('/egress-audio', this.egressWsBase);
    base.searchParams.set('roomName', args.roomName);
    if (args.participant) base.searchParams.set('participant', args.participant);
    base.searchParams.set('trackId', args.trackId);
    base.searchParams.set('meetingId', args.meetingId);
    base.searchParams.set('sampleRate', String(args.sampleRate));
    base.searchParams.set('channels', String(args.channels));
    if (args.groupSeconds && args.groupSeconds > 0)
      base.searchParams.set('groupSeconds', String(args.groupSeconds));
    return base.toString();
  }
}
