import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type CreateSessionInput = {
  meetingId: string; // recommended: LiveKit room SID
  roomName: string;
  roomSid?: string | null;
};

type SessionStatusLiteral = 'ACTIVE' | 'ENDED';
type SessionRecord = { meetingId: string };
interface SessionDelegateSubset {
  upsert(args: {
    where: { meetingId: string };
    create: {
      meetingId: string;
      roomName: string;
      roomSid: string | null;
      status: SessionStatusLiteral;
    };
    update: {
      roomName: string;
      roomSid: string | null;
      status: SessionStatusLiteral;
      endedAt: Date | null;
    };
  }): Promise<SessionRecord>;
  update(args: {
    where: { meetingId: string };
    data: { status: 'ENDED'; endedAt: Date };
  }): Promise<SessionRecord>;
  findFirst(args: {
    where: { roomName: string; status: SessionStatusLiteral };
    orderBy: { startedAt: 'desc' };
  }): Promise<SessionRecord | null>;
}
type PrismaSessionAPI = { session: SessionDelegateSubset };

@Injectable()
export class SessionsService {
  constructor(private readonly prismaService: PrismaService) {}

  private get prisma(): PrismaSessionAPI {
    return this.prismaService as unknown as PrismaSessionAPI;
  }

  async createOrActivate(input: CreateSessionInput) {
    const { meetingId, roomName, roomSid } = input;
    return this.prisma.session.upsert({
      where: { meetingId },
      create: {
        meetingId,
        roomName,
        roomSid: roomSid ?? null,
        status: 'ACTIVE',
      },
      update: {
        roomName,
        roomSid: roomSid ?? null,
        status: 'ACTIVE',
        endedAt: null,
      },
    });
  }

  async endByMeetingId(meetingId: string) {
    return this.prisma.session.update({
      where: { meetingId },
      data: { status: 'ENDED', endedAt: new Date() },
    });
  }

  async findActiveByRoomName(roomName: string) {
    return this.prisma.session.findFirst({
      where: { roomName, status: 'ACTIVE' },
      orderBy: { startedAt: 'desc' },
    });
  }
}
