import { randomUUID } from 'crypto';

/**
 * Generates a unique string id for feedback payloads.
 * Uses crypto.randomUUID() (Node 15.6+); no extra dependency.
 * Single source of truth for feedback id generation (see solution-understood-third-party-libs.spec.md).
 */
export function makeFeedbackId(): string {
  return randomUUID();
}
