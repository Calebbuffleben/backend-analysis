/**
 * Word-set containment similarity: returns true if max(intersection/|A|, intersection/|B|) >= threshold.
 * Used for same-segment suppression (e.g. avoid repeating feedback for very similar text).
 * Single source of truth (see solution-understood-third-party-libs.spec.md).
 */
export function textSimilar(a: string, b: string, threshold = 0.6): boolean {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return a === b;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const containment = Math.max(intersection / wordsA.size, intersection / wordsB.size);
  return containment >= threshold;
}
