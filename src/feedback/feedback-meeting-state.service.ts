import { Injectable } from '@nestjs/common';

export type PostInterruptionCandidate = {
  ts: number;
  interruptedId: string;
  valenceBefore?: number;
};

/**
 * Estado por reunião usado pela pipeline A2E2: overlap, interrupções, último falante, cooldowns de reunião.
 * Extraído do agregador para reduzir responsabilidades e permitir reuso.
 */
@Injectable()
export class FeedbackMeetingStateService {
  private readonly overlapHistoryByMeeting = new Map<string, number[]>();
  private readonly lastOverlapSampleAtByMeeting = new Map<string, number>();
  private readonly meetingCooldownByType = new Map<string, number>();
  private readonly lastSpeakerByMeeting = new Map<string, string>();
  private readonly postInterruptionCandidatesByMeeting = new Map<string, PostInterruptionCandidate[]>();

  inCooldownMeeting(meetingId: string, type: string, now: number): boolean {
    const key = `${meetingId}:${type}`;
    const until = this.meetingCooldownByType.get(key);
    return typeof until === 'number' && until > now;
  }

  setCooldownMeeting(meetingId: string, type: string, now: number, ms: number): void {
    const key = `${meetingId}:${type}`;
    this.meetingCooldownByType.set(key, now + ms);
  }

  getOverlapHistory(meetingId: string): number[] | undefined {
    return this.overlapHistoryByMeeting.get(meetingId);
  }

  updateOverlapHistory(meetingId: string, timestamps: number[]): void {
    this.overlapHistoryByMeeting.set(meetingId, timestamps);
  }

  getLastOverlapSampleAt(meetingId: string): number | undefined {
    return this.lastOverlapSampleAtByMeeting.get(meetingId);
  }

  setLastOverlapSampleAt(meetingId: string, timestamp: number): void {
    this.lastOverlapSampleAtByMeeting.set(meetingId, timestamp);
  }

  getLastSpeaker(meetingId: string): string | undefined {
    return this.lastSpeakerByMeeting.get(meetingId);
  }

  setLastSpeaker(meetingId: string, participantId: string): void {
    this.lastSpeakerByMeeting.set(meetingId, participantId);
  }

  getPostInterruptionCandidates(meetingId: string): PostInterruptionCandidate[] | undefined {
    return this.postInterruptionCandidatesByMeeting.get(meetingId);
  }

  updatePostInterruptionCandidates(meetingId: string, candidates: PostInterruptionCandidate[]): void {
    this.postInterruptionCandidatesByMeeting.set(meetingId, candidates);
  }
}
