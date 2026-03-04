/**
 * Truncate string with "..." when longer than maxLen.
 * Single source of truth (see solution-understood-third-party-libs.spec.md).
 */
export function truncateWithEllipsis(text: string, maxLen: number): string {
  const t = (text || '').trim();
  if (!t) return '';
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 3))}...`;
}
