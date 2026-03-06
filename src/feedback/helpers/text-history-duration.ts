/**
 * Entrada com timestamp (compatível com TextHistoryEntry e qualquer lista temporal).
 */
export interface TimestampedEntry {
  timestamp: number;
}

/**
 * Estima duração total de fala (ms) a partir de entradas em uma janela.
 * Duração dos chunks não é uniforme (ex.: buffer legado flush em 7s ou no timer).
 * Por segmento: se existir próxima entrada usa delta (limitado a segmentDurationMs);
 * senão usa segmentDurationMs para o último segmento.
 */
export function estimateSpeakingDurationMs(
  entries: TimestampedEntry[],
  now: number,
  windowMs: number,
  segmentDurationMs: number,
): number {
  const filtered = entries.filter((e) => e.timestamp >= now - windowMs);
  if (filtered.length === 0) return 0;
  const sorted = [...filtered].sort((a, b) => a.timestamp - b.timestamp);
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    let duration: number;
    if (next) {
      duration = Math.max(0, next.timestamp - current.timestamp);
      duration = Math.min(duration, segmentDurationMs);
    } else {
      duration = segmentDurationMs;
    }
    total += duration;
  }
  return total;
}
