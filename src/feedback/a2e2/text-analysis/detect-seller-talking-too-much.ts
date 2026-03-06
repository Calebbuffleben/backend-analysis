import { DetectionContext, ParticipantState } from "../types";
import { FeedbackEventPayload } from "@/feedback/feedback.types";
import { estimateSpeakingDurationMs } from "@/feedback/helpers";
import { parseEnvBool, readEnvNumber } from "@/feedback/utils/env";
import {
  FEEDBACK_TYPE_SELLER_TALKING,
  SALES_SELLER_TALKING_COOLDOWN_MS,
  SALES_SELLER_TALKING_MIN_TOTAL_MS,
  SALES_SELLER_TALKING_RATIO_THRESHOLD,
  SALES_SELLER_TALKING_SEGMENT_DURATION_MS,
  SALES_SELLER_TALKING_WINDOW_MS,
} from "../thresholds/seller-talking";

export class DetectSellerTalkingTooMuch {
  run(state: ParticipantState, ctx: DetectionContext): FeedbackEventPayload | null {
    const enabled = parseEnvBool('SALES_SELLER_TALKING_ENABLED', false);
    if (!enabled) return null;

    const now = ctx.now;
    const meetingId = ctx.meetingId;
    const participants = ctx.getParticipantsForMeeting?.(meetingId) ?? [];
    if (participants.length < 2) return null;

    const windowMs = readEnvNumber('SALES_SELLER_TALKING_WINDOW_MS', SALES_SELLER_TALKING_WINDOW_MS);
    const minTotalMs = readEnvNumber('SALES_SELLER_TALKING_MIN_TOTAL_MS', SALES_SELLER_TALKING_MIN_TOTAL_MS);
    const ratioThreshold = readEnvNumber('SALES_SELLER_TALKING_RATIO_THRESHOLD', SALES_SELLER_TALKING_RATIO_THRESHOLD);
    const segmentDurationMs = readEnvNumber('SALES_SELLER_TALKING_SEGMENT_DURATION_MS', SALES_SELLER_TALKING_SEGMENT_DURATION_MS);
    const cooldownMs = readEnvNumber('SALES_SELLER_TALKING_COOLDOWN_MS', SALES_SELLER_TALKING_COOLDOWN_MS);

    if (ctx.inCooldownMeeting?.(meetingId, FEEDBACK_TYPE_SELLER_TALKING, now)) return null;

    let sellerTimeMs = 0;
    let clientTimeMs = 0;
    let firstHostId: string | undefined;

    for (const [participantId, participantState] of participants) {
      const role = ctx.getParticipantRole?.(meetingId, participantId);
      const entries = participantState.textAnalysis?.textHistory ?? [];
      const durationMs = estimateSpeakingDurationMs(entries, now, windowMs, segmentDurationMs);
      if (role === 'host') {
        sellerTimeMs += durationMs;
        if (firstHostId === undefined) firstHostId = participantId;
      } else if (role === 'guest') {
        clientTimeMs += durationMs;
      }
    }

    const totalMs = sellerTimeMs + clientTimeMs;
    if (totalMs < minTotalMs) return null;

    const ratio = totalMs > 0 ? sellerTimeMs / totalMs : 0;
    if (ratio < ratioThreshold) return null;

    if (cooldownMs > 0 && ctx.setCooldownMeeting) {
      ctx.setCooldownMeeting(meetingId, FEEDBACK_TYPE_SELLER_TALKING, now, cooldownMs);
    }

    const windowStart = now - windowMs;
    const participantId = firstHostId ?? participants[0][0];

    return {
      id: ctx.makeId(),
      type: FEEDBACK_TYPE_SELLER_TALKING,
      severity: 'warning',
      ts: now,
      meetingId,
      participantId,
      participantName: ctx.getParticipantName(meetingId, participantId),
      window: { start: windowStart, end: now },
      message: 'Vendedor falando demais — dê mais espaço para o cliente falar',
      tips: ['Faça perguntas abertas', 'Pause após cada ponto para o cliente reagir'],
      metadata: {
        seller_time_ms: sellerTimeMs,
        client_time_ms: clientTimeMs,
        total_ms: totalMs,
        ratio: Math.round(ratio * 100) / 100,
      },
    };
  }
}
