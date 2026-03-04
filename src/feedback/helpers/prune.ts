import type { ParticipantState } from '../a2e2/types';

/**
 * Remove amostras do estado mais antigas que (now - pruneHorizonMs).
 */
export function pruneOldSamples(
  state: ParticipantState,
  now: number,
  pruneHorizonMs: number,
): void {
  const minTs = now - pruneHorizonMs;
  while (state.samples.length > 0 && state.samples[0].ts < minTs) {
    state.samples.shift();
  }
}
