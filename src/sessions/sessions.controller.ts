import { Controller, Get, Query } from '@nestjs/common';
import { SessionsService } from './sessions.service';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get('resolve')
  async resolveByRoomName(@Query('roomName') roomName?: string) {
    if (!roomName) {
      return { ok: false, error: 'roomName is required' };
    }
    const rec = await this.sessions.findActiveByRoomName(roomName);
    if (rec) {
      return { ok: true, meetingId: rec.meetingId, roomName };
    }
    // fallback: if no active session yet, frontend may join using roomName as key
    return { ok: true, meetingId: roomName, roomName, pending: true };
  }
}


