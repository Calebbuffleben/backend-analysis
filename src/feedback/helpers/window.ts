import type { ParticipantState } from '../a2e2/types';

export type WindowResult = {
  start: number;
  end: number;
  samplesCount: number;
  speechCount: number;
  meanRmsDbfs?: number;
};

/**
 * Computa métricas sobre amostras do participante numa janela [now - ms, now].
 */
export function computeWindow(
  state: ParticipantState,
  now: number,
  ms: number,
): WindowResult {
  const start = now - ms;
  let samplesCount = 0;
  let speechCount = 0;
  let rmsSum = 0;
  let rmsN = 0;
  for (let i = state.samples.length - 1; i >= 0; i--) {
    const s = state.samples[i];
    if (s.ts < start) break;
    samplesCount++;
    if (s.speech) speechCount++;
    if (typeof s.rmsDbfs === 'number') {
      rmsSum += s.rmsDbfs;
      rmsN++;
    }
  }
  const meanRmsDbfs = rmsN > 0 ? rmsSum / rmsN : undefined;
  return { start, end: now, samplesCount, speechCount, meanRmsDbfs };
}
