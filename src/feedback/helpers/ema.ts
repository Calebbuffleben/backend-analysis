import type { ParticipantState, Sample } from '../a2e2/types';

/**
 * Atualiza EMA do estado com uma nova amostra (valence, arousal, rms, emotions).
 */
export function updateEma(state: ParticipantState, s: Sample, alpha: number): void {
  const a = alpha;
  if (typeof s.valence === 'number') {
    state.ema.valence =
      typeof state.ema.valence === 'number'
        ? a * s.valence + (1 - a) * state.ema.valence
        : s.valence;
  }
  if (typeof s.arousal === 'number') {
    state.ema.arousal =
      typeof state.ema.arousal === 'number'
        ? a * s.arousal + (1 - a) * state.ema.arousal
        : s.arousal;
  }
  if (typeof s.rmsDbfs === 'number') {
    state.ema.rms =
      typeof state.ema.rms === 'number' ? a * s.rmsDbfs + (1 - a) * state.ema.rms : s.rmsDbfs;
  }
  if (s.emotions) {
    for (const [name, score] of Object.entries(s.emotions)) {
      const key = name.toLowerCase();
      const prev = state.ema.emotions.get(key);
      const next = typeof prev === 'number' ? a * score + (1 - a) * prev : score;
      state.ema.emotions.set(key, next);
    }
  }
}
