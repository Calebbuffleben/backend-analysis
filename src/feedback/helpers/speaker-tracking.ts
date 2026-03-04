import type { FeedbackMeetingStateService } from '../feedback-meeting-state.service';
import type { FeedbackParticipantStateService } from '../feedback-participant-state.service';
import { computeWindow } from './window';

export type SpeakerTrackingDeps = {
  participantState: FeedbackParticipantStateService;
  meetingState: FeedbackMeetingStateService;
  shortWindowMs: number;
};

/**
 * Atualiza o último falante da reunião com base na cobertura de fala na janela curta.
 */
export function updateSpeakerTracking(
  meetingId: string,
  now: number,
  deps: SpeakerTrackingDeps,
): void {
  const participants = deps.participantState.participantsForMeeting(meetingId);
  if (participants.length === 0) return;
  let topId: string | undefined;
  let topCov = 0;
  let secondCov = 0;
  for (const [pid, st] of participants) {
    const w = computeWindow(st, now, deps.shortWindowMs);
    if (w.samplesCount === 0) continue;
    const cov = w.speechCount / w.samplesCount;
    if (cov > topCov) {
      secondCov = topCov;
      topCov = cov;
      topId = pid;
    } else if (cov > secondCov) {
      secondCov = cov;
    }
  }
  if (topId && topCov >= 0.5 && secondCov < 0.2) {
    deps.meetingState.setLastSpeaker(meetingId, topId);
  }
}
