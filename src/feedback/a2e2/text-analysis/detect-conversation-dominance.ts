import { DetectionContext, ParticipantState } from "../types";
import { FeedbackEventPayload } from "@/feedback/feedback.types";
import { estimateSpeakingDurationMs } from "@/feedback/helpers";
import { parseEnvBool, readEnvNumber } from "@/feedback/utils/env";
import {
  FEEDBACK_TYPE_CONVERSATION_DOMINANCE,
  CONVERSATION_DOMINANCE_COOLDOWN_MS,
  CONVERSATION_DOMINANCE_ENABLED_DEFAULT,
  CONVERSATION_DOMINANCE_MIN_TOTAL_MS,
  CONVERSATION_DOMINANCE_RATIO_THRESHOLD,
  CONVERSATION_DOMINANCE_SEGMENT_DURATION_MS,
  CONVERSATION_DOMINANCE_WINDOW_MS,
} from "../thresholds/conversation-dominance";

export class DetectConversationDominance {
  run(state: ParticipantState, ctx: DetectionContext): FeedbackEventPayload | null {
    const enabled = parseEnvBool(
      'CONVERSATION_DOMINANCE_ENABLED',
      CONVERSATION_DOMINANCE_ENABLED_DEFAULT,
    );
    if (!enabled) return null;

    const now = ctx.now;
    const meetingId = ctx.meetingId;
    const participants = ctx.getParticipantsForMeeting?.(meetingId) ?? [];
    if (participants.length < 2) return null;

    const windowMs = readEnvNumber(
      'CONVERSATION_DOMINANCE_WINDOW_MS',
      CONVERSATION_DOMINANCE_WINDOW_MS,
    );
    const minTotalMs = readEnvNumber(
      'CONVERSATION_DOMINANCE_MIN_TOTAL_MS',
      CONVERSATION_DOMINANCE_MIN_TOTAL_MS,
    );
    const ratioThreshold = readEnvNumber(
      'CONVERSATION_DOMINANCE_RATIO_THRESHOLD',
      CONVERSATION_DOMINANCE_RATIO_THRESHOLD,
    );
    const segmentDurationMs = readEnvNumber(
      'CONVERSATION_DOMINANCE_SEGMENT_DURATION_MS',
      CONVERSATION_DOMINANCE_SEGMENT_DURATION_MS,
    );
    const cooldownMs = readEnvNumber(
      'CONVERSATION_DOMINANCE_COOLDOWN_MS',
      CONVERSATION_DOMINANCE_COOLDOWN_MS,
    );

    if (
      ctx.inCooldownMeeting?.(meetingId, FEEDBACK_TYPE_CONVERSATION_DOMINANCE, now)
    ) {
      return null;
    }

    let totalMs = 0;
    let maxDurationMs = 0;
    let dominantParticipantId: string | undefined;

    for (const [participantId, participantState] of participants) {
      const entries = participantState.textAnalysis?.textHistory ?? [];
      const durationMs = estimateSpeakingDurationMs(
        entries,
        now,
        windowMs,
        segmentDurationMs,
      );
      totalMs += durationMs;
      if (durationMs > maxDurationMs) {
        maxDurationMs = durationMs;
        dominantParticipantId = participantId;
      }
    }

    if (totalMs < minTotalMs) return null;

    const ratio = totalMs > 0 ? maxDurationMs / totalMs : 0;
    if (ratio < ratioThreshold) return null;

    if (cooldownMs > 0 && ctx.setCooldownMeeting) {
      ctx.setCooldownMeeting(
        meetingId,
        FEEDBACK_TYPE_CONVERSATION_DOMINANCE,
        now,
        cooldownMs,
      );
    }

    const windowStart = now - windowMs;
    const participantId = dominantParticipantId ?? participants[0][0];

    return {
      id: ctx.makeId(),
      type: FEEDBACK_TYPE_CONVERSATION_DOMINANCE,
      severity: 'warning',
      ts: now,
      meetingId,
      participantId,
      participantName: ctx.getParticipantName(meetingId, participantId),
      window: { start: windowStart, end: now },
      message:
        'Um participante está dominando a conversa — dê mais espaço para os outros',
      tips: [
        'Faça perguntas abertas',
        'Pause após cada ponto para os outros reagirem',
      ],
      metadata: {
        dominant_time_ms: maxDurationMs,
        total_ms: totalMs,
        ratio: Math.round(ratio * 100) / 100,
      },
    };
  }
}
