import { Injectable } from '@nestjs/common';
import type { ParticipantState } from './a2e2/types';

/**
 * Estado por participante: armazenamento (byKey) e helpers de cooldown/init.
 * Extraído do agregador para reduzir responsabilidades e centralizar acesso ao estado.
 */
@Injectable()
export class FeedbackParticipantStateService {
  private readonly byKey = new Map<string, ParticipantState>();

  key(meetingId: string, participantId: string): string {
    return `${meetingId}:${participantId}`;
  }

  getState(meetingId: string, participantId: string): ParticipantState | undefined {
    return this.byKey.get(this.key(meetingId, participantId));
  }

  getOrCreateState(meetingId: string, participantId: string): ParticipantState {
    const k = this.key(meetingId, participantId);
    let state = this.byKey.get(k);
    if (!state) {
      state = this.initState();
      this.byKey.set(k, state);
    }
    return state;
  }

  participantsForMeeting(meetingId: string): Array<[string, ParticipantState]> {
    const out: Array<[string, ParticipantState]> = [];
    const prefix = `${meetingId}:`;
    for (const [k, st] of this.byKey.entries()) {
      if (k.startsWith(prefix)) {
        const pid = k.slice(prefix.length);
        out.push([pid, st]);
      }
    }
    return out;
  }

  inCooldown(state: ParticipantState, type: string, now: number): boolean {
    const until = state.cooldownUntilByType.get(type);
    return typeof until === 'number' && until > now;
  }

  cooldownRemainingMs(state: ParticipantState, type: string, now: number): number {
    const until = state.cooldownUntilByType.get(type);
    if (typeof until !== 'number') return 0;
    return Math.max(0, until - now);
  }

  setCooldown(state: ParticipantState, type: string, now: number, ms: number): void {
    state.cooldownUntilByType.set(type, now + ms);
    state.lastFeedbackAt = now;
  }

  inGlobalCooldown(state: ParticipantState, now: number, minGapMs = 2000): boolean {
    return typeof state.lastFeedbackAt === 'number' && now - state.lastFeedbackAt < minGapMs;
  }

  private initState(): ParticipantState {
    return {
      samples: [],
      ema: {
        emotions: new Map(),
      },
      cooldownUntilByType: new Map<string, number>(),
    };
  }
}
