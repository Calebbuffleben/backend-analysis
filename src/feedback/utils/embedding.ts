import type { Logger } from '@nestjs/common';

/**
 * Minimum expected embedding dimension (SBERT MiniLM etc. typically 384).
 * If we receive an array with length < this, it's likely a bug (e.g. single value).
 */
const MIN_EMBEDDING_DIM = 32;

/**
 * Normalizes the raw `embedding` value from the text-analysis payload.
 * Python should send a list of floats (e.g. 384 dims). If we receive a scalar
 * (e.g. 0.7 or 0) due to a bug or wrong serialization, we identify it and return
 * undefined so the backend doesn't treat it as a valid vector.
 *
 * @param raw - Value from evt.analysis.embedding (may be number[], number, or wrong type)
 * @param logContext - Optional logger and context to log when invalid shape is detected
 * @returns number[] valid vector, or undefined if invalid/missing
 */
export function normalizeEmbedding(
  raw: unknown,
  logContext?: { logger: Logger; meetingId?: string; participantId?: string },
): number[] | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }

  if (typeof raw === 'number') {
    logContext?.logger.warn(
      '[EMBEDDING] Received as scalar (expected array from Python); solution_understood will not use it',
      {
        embedding_received_as_scalar: true,
        value: raw,
        meetingId: logContext?.meetingId,
        participantId: logContext?.participantId,
        hint: 'Python should send analysis.embedding as list of floats (e.g. 384 dims). Check semantic_pipeline and JSON serialization.',
      },
    );
    return undefined;
  }

  if (!Array.isArray(raw)) {
    logContext?.logger.warn(
      '[EMBEDDING] Invalid type (expected array)',
      {
        embedding_invalid_type: typeof raw,
        meetingId: logContext?.meetingId,
        participantId: logContext?.participantId,
      },
    );
    return undefined;
  }

  const arr = raw.filter((x): x is number => typeof x === 'number');
  if (arr.length !== raw.length) {
    logContext?.logger.warn(
      '[EMBEDDING] Array contained non-numbers; dropped invalid elements',
      {
        originalLength: raw.length,
        validLength: arr.length,
        meetingId: logContext?.meetingId,
        participantId: logContext?.participantId,
      },
    );
  }

  if (arr.length < MIN_EMBEDDING_DIM) {
    logContext?.logger.warn(
      '[EMBEDDING] Array too short (expected SBERT vector, e.g. 384 dims)',
      {
        embedding_too_short: true,
        length: arr.length,
        minExpected: MIN_EMBEDDING_DIM,
        meetingId: logContext?.meetingId,
        participantId: logContext?.participantId,
        hint: 'If length is 1, Python may have sent a single similarity score instead of the embedding vector.',
      },
    );
    return undefined;
  }

  return arr;
}
