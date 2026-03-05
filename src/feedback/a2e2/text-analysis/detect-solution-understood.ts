import { TextAnalysisResult } from "@/pipeline/text-analysis.service";
import { DetectionContext, ParticipantState } from "../types";
import { FeedbackEventPayload } from "@/feedback/feedback.types";
import { makeFeedbackId } from "@/feedback/utils/id";
import { parseEnvBool } from "@/feedback/utils/env";
import { truncateWithEllipsis } from "@/feedback/utils/snippet";
import { textSimilar } from "@/feedback/utils/text-similarity";
import { cosineSimilarity as fastCosineSimilarity } from "fast-cosine-similarity";
import { Matrix } from "ml-matrix";
import { Logger } from "@nestjs/common";

/** Cosine similarity; returns 0 for empty, length mismatch, or invalid (preserves prior contract). */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  try {
    const s = fastCosineSimilarity(a, b);
    return Number.isFinite(s) ? s : 0;
  } catch {
    return 0;
  }
}

/** Single rule: marker + similarity >= MIN_SIMILARITY. Env: SALES_SOLUTION_UNDERSTOOD_MIN_SIMILARITY */
const DEFAULT_MIN_SIMILARITY = 0.65;
/** Minimum text length (hardcoded, no env). */
const MIN_CHARS_HARDCODED = 20;
/** Same-segment suppression window (ms). */
const SAME_SEGMENT_WINDOW_MS = 60_000;
const PAYLOAD_WINDOW_MS = 60_000;

export class DetectSolutionUnderstood {
  private readonly logger = new Logger(DetectSolutionUnderstood.name);

  /**
   * A2E2 API: (state, ctx) -> FeedbackEventPayload | null.
   * Single rule: reformulation marker present + similarity to others' context >= MIN_SIMILARITY.
   * Context = centroid of each other participant's latest entry in window (Option B).
   */
  run(state: ParticipantState, ctx: DetectionContext): FeedbackEventPayload | null {
    const meetingId = ctx.meetingId;
    const participantId = ctx.participantId;
    const now = ctx.now;
    const participantName = ctx.getParticipantName(meetingId, participantId);

    const latestText = state.textAnalysis?.textHistory?.slice(-1)[0]?.text || '';
    const evt = {
      meetingId,
      participantId,
      text: latestText,
      timestamp: now,
      analysis: {
        embedding: state.textAnalysis?.embedding ?? [],
        keywords: state.textAnalysis?.keywords ?? [],
        speech_act: state.textAnalysis?.speech_act ?? '',
      },
    } as unknown as TextAnalysisResult;

    const feedback = this.detect(state, evt, now, ctx);
    if (feedback && !feedback.participantName && participantName) {
      feedback.participantName = participantName;
    }
    return feedback;
  }

  /**
   * Single rule: marker present + similarity(current, centroid of others' latest entries) >= MIN_SIMILARITY.
   * Confidence = similarityRaw.
   */
  private detect(
    state: ParticipantState,
    evt: TextAnalysisResult,
    now: number,
    ctx: DetectionContext,
  ): FeedbackEventPayload | null {
    const enabled = parseEnvBool('SALES_SOLUTION_UNDERSTOOD_ENABLED', false);
    if (!enabled) return null;
    const debug = parseEnvBool('SALES_SOLUTION_UNDERSTOOD_DEBUG', false);

    const text = (evt.text || '').trim();
    const embedding = evt.analysis.embedding;

    if (debug) {
      this.logger.debug('[SOLUTION_UNDERSTOOD] Evaluate', {
        meetingId: evt.meetingId,
        participantId: evt.participantId,
        textLen: text.length,
        embeddingLen: Array.isArray(embedding) ? embedding.length : 0,
      });
    }

    if (!text || !Array.isArray(embedding) || embedding.length === 0) {
      if (debug) this.logger.debug('[SOLUTION_UNDERSTOOD] Skip: missing text or empty embedding');
      return null;
    }

    const role = ctx.getParticipantRole?.(evt.meetingId, evt.participantId);
    if (role === 'host') {
      if (debug) this.logger.debug('[SOLUTION_UNDERSTOOD] Skip: participant is host (only client can trigger)');
      return null;
    }

    const cooldownRaw = process.env.SALES_SOLUTION_UNDERSTOOD_COOLDOWN_MS;
    const cooldownParsed = cooldownRaw ? Number.parseInt(cooldownRaw.replace(/"/g, ''), 10) : 120000;
    const effectiveCooldownMs = Number.isFinite(cooldownParsed) ? Math.max(0, cooldownParsed) : 120000;
    if (effectiveCooldownMs > 0 && this.inCooldown(state, 'sales_solution_understood', Date.now())) {
      if (debug) this.logger.debug('[SOLUTION_UNDERSTOOD] Skip: in cooldown');
      return null;
    }

    const timeSinceLast = typeof state.lastFeedbackTextAt === 'number' ? now - state.lastFeedbackTextAt : Infinity;
    if (
      timeSinceLast < SAME_SEGMENT_WINDOW_MS &&
      state.lastFeedbackText &&
      textSimilar(state.lastFeedbackText, evt.text ?? '', 0.6)
    ) {
      if (debug) this.logger.debug('[SOLUTION_UNDERSTOOD] Skip: same-segment suppression (similar to last feedback text)');
      return null;
    }

    const markers = this.detectReformulationMarkers(text);
    if (markers.length === 0) {
      if (debug) this.logger.debug('[SOLUTION_UNDERSTOOD] Skip: no reformulation marker in text', { textExcerpt: text.slice(0, 80) });
      return null;
    }

    if (text.length < MIN_CHARS_HARDCODED) {
      if (debug) this.logger.debug('[SOLUTION_UNDERSTOOD] Skip: text shorter than MIN_CHARS', { len: text.length, min: MIN_CHARS_HARDCODED });
      return null;
    }

    const contextEntries = this.getLatestEntryPerOtherParticipant(evt.meetingId, evt.participantId, now, ctx);
    if (contextEntries.length === 0) {
      if (debug) {
        const participants = ctx.getParticipantsForMeeting?.(evt.meetingId) ?? [];
        const otherCount = participants.filter(([pid]) => pid !== evt.participantId).length;
        const withHistory = participants.filter(([, s]) => (s.textAnalysis?.textHistory?.length ?? 0) > 0).length;
        this.logger.debug('[SOLUTION_UNDERSTOOD] Skip: no context from other participants', {
          otherParticipantsCount: otherCount,
          participantsWithTextHistory: withHistory,
          hint: 'Need at least one other participant with textHistory entries (with embedding) in the context window.',
        });
      }
      return null;
    }

    const centroid = this.meanEmbedding(contextEntries.map((e) => e.embedding));
    if (!centroid) {
      if (debug) this.logger.debug('[SOLUTION_UNDERSTOOD] Skip: centroid computation failed');
      return null;
    }

    const similarityRaw = cosineSimilarity(embedding, centroid);
    const minSimRaw = process.env.SALES_SOLUTION_UNDERSTOOD_MIN_SIMILARITY ?? process.env.SALES_SOLUTION_UNDERSTOOD_THRESHOLD;
    const minSimParsed = minSimRaw ? Number.parseFloat(String(minSimRaw).replace(/"/g, '')) : DEFAULT_MIN_SIMILARITY;
    const minSimilarity = Number.isFinite(minSimParsed) ? Math.max(0, Math.min(1, minSimParsed)) : DEFAULT_MIN_SIMILARITY;
    if (similarityRaw < minSimilarity) {
      if (debug) this.logger.debug('[SOLUTION_UNDERSTOOD] Skip: similarity below threshold', {
        similarityRaw: Math.round(similarityRaw * 1000) / 1000,
        minSimilarity,
      });
      return null;
    }

    const confidence = similarityRaw;
    if (effectiveCooldownMs > 0) {
      this.setCooldown(state, 'sales_solution_understood', Date.now(), effectiveCooldownMs);
    }

    const bestContext = contextEntries[contextEntries.length - 1];
    const contextExcerpt = bestContext ? truncateWithEllipsis(bestContext.text, 180) : '';
    const clientExcerpt = truncateWithEllipsis(text, 180);
    const windowStart = now - PAYLOAD_WINDOW_MS;

    this.logger.log('[SOLUTION_UNDERSTOOD] Triggered', {
      meetingId: evt.meetingId,
      participantId: evt.participantId,
      confidence: Math.round(confidence * 1000) / 1000,
    });

    return {
      id: makeFeedbackId(),
      type: 'sales_solution_understood',
      severity: 'info',
      ts: now,
      meetingId: evt.meetingId,
      participantId: evt.participantId,
      participantName: undefined,
      window: { start: windowStart, end: now },
      message: 'Cliente reformulou sua solução — parece que entendeu.',
      tips: ['Confirme: "Perfeito — é isso mesmo."', 'Valide o próximo passo: "Faz sentido avançarmos?"'],
      metadata: {
        confidence: Math.round(confidence * 100) / 100,
        similarity_raw: Math.round(similarityRaw * 1000) / 1000,
        markers_detected: markers,
        solution_context_excerpt: contextExcerpt,
        client_reformulation_excerpt: clientExcerpt,
      },
    };
  }

  private detectReformulationMarkers(text: string): string[] {
    const t = text.toLowerCase();
    const markers = [
      'deixa eu ver se entendi',
      'só pra confirmar',
      'se eu entendi',
      'entendi então',
      'entendi que',
      'então vocês',
      'então o que você está dizendo é',
      'quer dizer que',
      'ou seja',
      'resumindo',
      'em resumo',
      'na prática então',
      'basicamente',
    ];
    const found: string[] = [];
    for (const m of markers) {
      if (t.includes(m)) found.push(m);
    }
    return found;
  }

  private inCooldown(state: ParticipantState, type: string, now: number): boolean {
    const until = state.cooldownUntilByType.get(type);
    return typeof until === 'number' && until > now;
  }

  /**
   * Option B: one entry per other participant — the latest (most recent) entry in the time window with embedding.
   * Centroid is built from these N embeddings. No role required.
   */
  private getLatestEntryPerOtherParticipant(
    meetingId: string,
    currentParticipantId: string,
    now: number,
    ctx: DetectionContext,
  ): Array<{ participantId: string; text: string; embedding: number[]; ts: number }> {
    const windowMsRaw = process.env.SALES_SOLUTION_CONTEXT_WINDOW_MS;
    const windowMsParsed = windowMsRaw ? Number.parseInt(windowMsRaw.replace(/"/g, ''), 10) : 90_000;
    const windowMs = Number.isFinite(windowMsParsed) ? Math.max(10_000, windowMsParsed) : 90_000;
    const cutoff = now - windowMs;

    const result: Array<{ participantId: string; text: string; embedding: number[]; ts: number }> = [];

    if (!ctx.getParticipantsForMeeting) return result;

    const participants = ctx.getParticipantsForMeeting(meetingId);

    for (const [participantId, state] of participants) {
      if (participantId === currentParticipantId) continue;

      const textHistory = state.textAnalysis?.textHistory ?? [];
      let latest: { text: string; embedding: number[]; ts: number } | null = null;

      for (const entry of textHistory) {
        if (entry.timestamp < cutoff) continue;
        const text = entry.text?.trim();
        const embedding = entry.embedding;
        if (!text || !embedding || embedding.length === 0) continue;
        if (!latest || entry.timestamp > latest.ts) {
          latest = { text, embedding, ts: entry.timestamp };
        }
      }

      if (latest) {
        result.push({
          participantId,
          text: latest.text,
          embedding: latest.embedding,
          ts: latest.ts,
        });
      }
    }

    return result;
  }

  private meanEmbedding(vectors: number[][]): number[] | null {
    if (vectors.length === 0) return null;
    const dim = vectors[0].length;
    if (dim === 0) return null;
    for (const v of vectors) {
      if (v.length !== dim) return null;
    }
    const matrix = new Matrix(vectors);
    return matrix.mean("column");
  }

  private setCooldown(state: ParticipantState, type: string, now: number, ms: number): void {
    state.cooldownUntilByType.set(type, now + ms);
    state.lastFeedbackAt = now;
  }

}