import { Injectable, Logger } from '@nestjs/common';

export type ParticipantRoles = 'host' | 'guest';

type MeetingMaps = {
  trackToParticipant: Map<string, string>;
  participantToRoles: Map<string, Set<ParticipantRoles>>;
  participantToName: Map<string, string>;
};

@Injectable()
export class ParticipantIndexService {
  private readonly logger = new Logger(ParticipantIndexService.name);
  private readonly byMeeting = new Map<string, MeetingMaps>();

  registerTrack(meetingId: string, trackSid: string, participantIdentity: string): void {
    const maps = this.getOrCreate(meetingId);
    maps.trackToParticipant.set(trackSid, participantIdentity);
  }

  resolveParticipantByTrack(meetingId: string, trackSid: string): string | undefined {
    return this.byMeeting.get(meetingId)?.trackToParticipant.get(trackSid);
  }

  setParticipantRolesFromMetadata(
    meetingId: string,
    participantIdentity: string,
    metadata: string | undefined,
  ): void {
    const maps = this.getOrCreate(meetingId);
    const roles = this.parseRoles(metadata);
    if (roles.size === 0) return;
    maps.participantToRoles.set(participantIdentity, roles);
    this.logger.log(
      `[Roles] meeting=${meetingId} participant=${participantIdentity} roles=${Array.from(roles).join(',')}`,
    );
  }

  getParticipantRole(meetingId: string, participantIdentity: string): 'host' | 'guest' | 'unknown' {
    const roles = this.byMeeting.get(meetingId)?.participantToRoles.get(participantIdentity);
    if (!roles) return 'unknown';
    if (roles.has('host')) return 'host';
    return 'guest';
  }

  setParticipantNameFromMetadata(meetingId: string, participantIdentity: string, metadata: string | undefined): void {
    const maps = this.getOrCreate(meetingId);
    const name = this.parseName(metadata) ?? participantIdentity;
    maps.participantToName.set(participantIdentity, name);
    this.logger.log(`[Name] meeting=${meetingId} participant=${participantIdentity} name="${name}"`);
  }

  getParticipantName(meetingId: string, participantIdentity: string): string | undefined {
    return this.byMeeting.get(meetingId)?.participantToName.get(participantIdentity);
  }

  clearMeeting(meetingId: string): void {
    this.byMeeting.delete(meetingId);
  }

  private getOrCreate(meetingId: string): MeetingMaps {
    let maps = this.byMeeting.get(meetingId);
    if (!maps) {
      maps = {
        trackToParticipant: new Map<string, string>(),
        participantToRoles: new Map<string, Set<ParticipantRoles>>(),
        participantToName: new Map<string, string>(),
      };
      this.byMeeting.set(meetingId, maps);
    }
    return maps;
  }

  private parseRoles(metadata: string | undefined): Set<ParticipantRoles> {
    const roles = new Set<ParticipantRoles>();
    if (!metadata) return roles;
    try {
      const parsed = JSON.parse(metadata) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        const anyObj = parsed as Record<string, unknown>;
        const role = anyObj['role'];
        const rolesArr = anyObj['roles'];
        const isHost = anyObj['isHost'];
        if (typeof role === 'string' && role.toLowerCase() === 'host') {
          roles.add('host');
        }
        if (Array.isArray(rolesArr)) {
          for (const r of rolesArr) {
            if (typeof r === 'string' && r.toLowerCase() === 'host') {
              roles.add('host');
            }
          }
        }
        if (typeof isHost === 'boolean' && isHost) {
          roles.add('host');
        }
      }
    } catch {
      // ignore
    }
    // default guest if nothing explicitly host? we leave empty to be 'unknown' until needed
    return roles;
  }

  private parseName(metadata: string | undefined): string | undefined {
    if (!metadata) return undefined;
    try {
      const parsed = JSON.parse(metadata) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        const anyObj = parsed as Record<string, unknown>;
        const name1 = anyObj['name'];
        const name2 = anyObj['displayName'];
        const name3 = anyObj['participantName'];
        if (typeof name1 === 'string' && name1.trim().length > 0) return name1.trim();
        if (typeof name2 === 'string' && name2.trim().length > 0) return name2.trim();
        if (typeof name3 === 'string' && name3.trim().length > 0) return name3.trim();
      }
    } catch {
      // ignore
    }
    return undefined;
  }
}
