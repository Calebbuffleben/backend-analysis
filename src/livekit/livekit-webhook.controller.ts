import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SessionsService } from '../sessions/sessions.service';
import { LiveKitEgressService } from './livekit-egress.service';
import { ParticipantIndexService } from './participant-index.service';

// Minimal type for LiveKit webhook room events we care about
interface LiveKitRoomPayload {
  event?: string;
  room?: {
    sid?: string;
    name: string;
  };
  participant?: {
    identity?: string;
    sid?: string;
    metadata?: string;
  };
  track?: {
    sid?: string;
    type?: string;
    source?: string;
  };
}

@Controller('livekit')
export class LiveKitWebhookController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly egress: LiveKitEgressService,
    private readonly index: ParticipantIndexService,
  ) {}

  @Post('webhook')
  @HttpCode(204)
  async handleWebhook(@Body() payload: LiveKitRoomPayload, @Req() req: Request) {
    const event = payload?.event ?? '';
    const ct = req.headers['content-type'] || '';
    console.log(`[LiveKitWebhook] event=${event} room=${payload?.room?.name ?? ''} ct=${ct}`);
    if (!payload?.room?.name && Object.keys(payload ?? {}).length > 0) {
      console.log(`[LiveKitWebhook] payload keys: ${Object.keys(payload).join(',')}`);
    }
    if (payload?.room?.name) {
      const meetingId = payload.room.sid ?? payload.room.name;
      if (event === 'room_started' || event === 'room_created' || event === '') {
        await this.sessions.createOrActivate({
          meetingId,
          roomName: payload.room.name,
          roomSid: payload.room.sid ?? null,
        });
      }
      if (event === 'room_finished' || event === 'room_ended' || event === 'room_deleted') {
        await this.sessions.endByMeetingId(meetingId);
        this.index.clearMeeting(meetingId);
      }
    }

    // Participant events → record roles from metadata
    if (payload?.participant?.identity && payload?.room?.name) {
      const meetingId = payload.room.sid ?? payload.room.name;
      if (event === 'participant_joined' || event === 'participant_updated') {
        const identity = payload.participant.identity;
        const metadata = payload.participant.metadata;
        this.index.setParticipantRolesFromMetadata(meetingId, identity, metadata);
        this.index.setParticipantNameFromMetadata(meetingId, identity, metadata);
      }
    }

    // Track published → start audio track egress
    if (payload?.event === 'track_published' || payload?.track?.sid) {
      const roomName = payload.room?.name;
      const meetingId = payload.room?.sid ?? roomName;
      const trackId = payload.track?.sid;
      const type = (payload.track?.type || '').toString();
      const source = (payload.track?.source || '').toString();
      console.log(
        `[LiveKitWebhook] track_published room=${roomName} meetingId=${meetingId} trackId=${trackId} type=${type} source=${source}`,
      );
      const isAudio =
        type.toUpperCase() === 'AUDIO' || source.toLowerCase() === 'microphone' || source === '';
      if (roomName && meetingId && trackId && isAudio) {
        // Ensure session exists/active even if room_started wasn't delivered
        await this.sessions.createOrActivate({
          meetingId,
          roomName,
          roomSid: payload.room?.sid ?? null,
        });
        const identity = payload.participant?.identity ?? '';
        if (identity) {
          this.index.registerTrack(meetingId, trackId, identity);
        }
        try {
          await this.egress.startAudioTrackEgress({
            roomName,
            participant: identity,
            trackId,
            meetingId,
            sampleRate: 48000,
            channels: 1,
            groupSeconds: Number(process.env.AUDIO_PIPELINE_GROUP_SECONDS || '2'),
          });
          console.log(`[LiveKitWebhook] startTrackEgress requested for trackId=${trackId}`);
        } catch (e) {
          console.error(`[LiveKitWebhook] startTrackEgress error: ${String(e)}`);
        }
      } else {
        console.log(
          `[LiveKitWebhook] skip egress (roomName=${roomName} meetingId=${meetingId} trackId=${trackId} isAudio=${isAudio})`,
        );
      }
    }
    return;
  }
}
